import { callPlugin } from "../bridge/pluginClient.js";
import { checkAlignmentCriteria } from "../criteria/alignmentCriteria.js";
import { checkProfileCriteria } from "../criteria/profileCriteria.js";
import type { CheckItem } from "../criteria/types/CheckItem.js";
import type { CriteriaReport } from "../criteria/types/CriteriaReport.js";
import { loadFix, logChange, registerFixes } from "./changeStore.js";
import { describe, describeCreate } from "./describe.js";
import { failureGuide } from "../errors/failureGuide.js";
import type { ChangeLogEntry } from "./types/ChangeLogEntry.js";
import type { StoredFix } from "./types/StoredFix.js";
import { trackApplied } from "../tracking/trackApplied.js";

// "곡선 2 (0+900.00~1+050.00)" → "곡선 2": a new radius moves the curve's end station,
// so the same curve is found again by its number.
const targetKey = (target: string) => /^(곡선|경사) \d+/.exec(target)?.[0] ?? target;

// Applies one computed fix the user agreed to, then runs the same check again so the
// answer can say whether the target now passes. Only fixes offered earlier in this
// conversation are accepted; the plug-in checks each value is still what the fix was
// computed from and applies all of them as one undo step.
export async function applyFix(fixId: string, offered: string[]) {
  if (!offered.includes(fixId))
    throw new Error(`Fix ${fixId} was not offered to the user in this conversation. Show it and ask before applying.`);
  const fix = await loadFix(fixId);
  if (!fix.applicable) throw new Error(fix.status === "conflict"
    ? `Fix ${fixId} cannot be applied: ${fix.reason ?? "it conflicts with neighbouring elements"}.`
    : `Fix ${fixId} has changes the plug-in cannot apply; the user must change the drawing by hand.`);

  const labels = fix.create ? [describeCreate(fix.create)] : fix.changes.map(describe);
  let result: ChangeLogEntry["result"];
  try {
    result = fix.create
      ? await callPlugin("alignment.create", fix.create).then(created => (
        { created, revision: (created as { revision: string }).revision })) as ChangeLogEntry["result"]
      : await callPlugin("change.apply", { changes: fix.changes.map(item => ({
        kind: item.object.kind, handle: item.object.handle, at: item.object.at, property: item.property, from: item.from, to: item.to
      })) }) as ChangeLogEntry["result"];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await logChange({ fixId, state: "failed", title: fix.title, target: fix.target, check: fix.check, labels, error: message });
    const guide = failureGuide(message);
    return { applied: false, fix: fix.title, error: message, drawingChanged: guide.drawingChanged, guide };
  }
  await logChange({ fixId, state: "applied", title: fix.title, target: fix.target, check: fix.check, labels, result });
  await trackApplied(fix, result);
  return { applied: true, fix: fix.title, ...(result?.created ? { created: result.created } : { changes: result?.changes }),
    undo: "Ctrl+Z 한 번(또는 UNDO 1)으로 되돌릴 수 있음",
    recheck: fix.source.check === "none" ? "용도에 도로가 없어 설계 기준 검토 없음" : await recheck(fix) };
}

// A created alignment is checked as a whole; a fix only for its target curve or grade.
async function recheck(fix: StoredFix) {
  if (fix.source.check === "none") return undefined;
  const reports: CriteriaReport[] = fix.source.check === "alignment"
    ? [await checkAlignmentCriteria(fix.source.input)]
    : await checkProfileCriteria(fix.source.input);
  const items = reports.flatMap(report => report.items);
  await registerFixes(items, fix.source);
  const key = targetKey(fix.target);
  const sameTarget = fix.create ? items : items.filter(item => targetKey(item.target) === key);
  const failed = (list: CheckItem[]) => list.filter(item => item.result === "fail");
  return {
    target: fix.target,
    targetPassed: failed(sameTarget).length === 0,
    targetItems: sameTarget,
    otherFailures: fix.create ? [] : failed(items).filter(item => targetKey(item.target) !== key),
    summary: reports.map(report => ({ target: report.target, ...report.summary }))
  };
}
