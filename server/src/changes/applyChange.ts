// 사용자가 동의한 수정안 하나를 도면에 적용하고(apply_drawing_change 도구),
// 같은 검토를 다시 돌려 대상이 이제 통과하는지 알려 준다.
//
// 안전장치:
//   - 이 대화에서 앞서 보여 준 수정안만 받는다.
//   - 플러그인이 적용 직전에 값이 수정안을 계산할 때 그대로인지 확인하고,
//     모든 변경을 되돌리기(UNDO) 한 번으로 묶어 적용한다.

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

// "곡선 2 (0+900.00~1+050.00)" → "곡선 2".
// 반지름이 바뀌면 곡선 끝 측점이 움직이므로, 다시 검토할 때는 번호로 같은 곡선을 찾는다.
const targetKey = (target: string) => /^(곡선|경사) \d+/.exec(target)?.[0] ?? target;

export async function applyFix(fixId: string, offered: string[]) {
  // 1) 적용해도 되는 수정안인지
  if (!offered.includes(fixId))
    throw new Error(`Fix ${fixId} was not offered to the user in this conversation. Show it and ask before applying.`);
  const fix = await loadFix(fixId);
  if (!fix.applicable) {
    throw new Error(fix.status === "conflict"
      ? `Fix ${fixId} cannot be applied: ${fix.reason ?? "it conflicts with neighbouring elements"}.`
      : `Fix ${fixId} has changes the plug-in cannot apply; the user must change the drawing by hand.`);
  }

  // 2) 플러그인에 적용 요청 (선형 생성 또는 값 변경)
  const labels = fix.create ? [describeCreate(fix.create)] : fix.changes.map(describe);
  let result: ChangeLogEntry["result"];
  try {
    if (fix.create) {
      const created = await callPlugin("alignment.create", fix.create);
      result = { created, revision: (created as { revision: string }).revision } as ChangeLogEntry["result"];
    } else {
      const changes = fix.changes.map(item => ({
        kind: item.object.kind,
        handle: item.object.handle,
        at: item.object.at,
        property: item.property,
        from: item.from,
        to: item.to
      }));
      result = await callPlugin("change.apply", { changes }) as ChangeLogEntry["result"];
    }
  } catch (error) {
    // 실패: 기록하고, 무슨 뜻인지·도면이 바뀌었는지 안내와 함께 돌려준다.
    const message = error instanceof Error ? error.message : String(error);
    await logChange({ fixId, state: "failed", title: fix.title, target: fix.target, check: fix.check, labels, error: message });
    const guide = failureGuide(message);
    return { applied: false, fix: fix.title, error: message, drawingChanged: guide.drawingChanged, guide };
  }

  // 3) 성공: 기록하고, 사람이 나중에 이 값을 고치는지 추적을 시작한다.
  await logChange({ fixId, state: "applied", title: fix.title, target: fix.target, check: fix.check, labels, result });
  await trackApplied(fix, result);

  // 4) 같은 검토를 다시 돌린 결과와 함께 돌려준다.
  return {
    applied: true,
    fix: fix.title,
    ...(result?.created ? { created: result.created } : { changes: result?.changes }),
    undo: "Ctrl+Z 한 번(또는 UNDO 1)으로 되돌릴 수 있음",
    recheck: fix.source.check === "none" ? "용도에 도로가 없어 설계 기준 검토 없음" : await recheck(fix)
  };
}

// 다시 검토: 새로 만든 선형은 선형 전체를, 수정안은 대상 곡선·경사만 본다.
async function recheck(fix: StoredFix) {
  if (fix.source.check === "none") return undefined;

  const reports: CriteriaReport[] = fix.source.check === "alignment"
    ? [await checkAlignmentCriteria(fix.source.input)]
    : await checkProfileCriteria(fix.source.input);
  const items = reports.flatMap(report => report.items);

  // 다시 검토에서 나온 새 수정안도 저장해 둔다(아직 미달이면 다음 수정안을 제안할 수 있게).
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
