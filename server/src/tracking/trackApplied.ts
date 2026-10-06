import { readRecord } from "../civil/alignmentRecord.js";
import type { ChangeLogEntry } from "../changes/types/ChangeLogEntry.js";
import type { StoredFix } from "../changes/types/StoredFix.js";
import { addTerms } from "../data/terms.js";
import { currentDrawingScope } from "../memory/drawingScope.js";
import { track, type TrackConditions, type Tracked } from "./tracker.js";

type NewItem = Omit<Tracked, "id" | "lastValue" | "createdAt">;

// Which values of an applied fix or created alignment to watch, and the design conditions
// they were made under (the central server compares changes per condition).
export function trackedItems(fix: StoredFix, result: NonNullable<ChangeLogEntry["result"]>): NewItem[] {
  if (fix.create && result.created) {
    const record = readRecord(fix.create.description);
    const conditions: TrackConditions = {
      ...(fix.create.designSpeed !== undefined ? { designSpeed: fix.create.designSpeed } : {}),
      ...(record.criteria ? { criteria: record.criteria } : {}),
      ...(record.roadClass ? { roadClass: record.roadClass } : {}),
      ...(record.region ? { region: record.region } : {})
    };
    const created = result.created;
    const groups = created.curves.length;
    return created.curves.flatMap((curve, index): NewItem[] => [
      { source: "create", check: "alignment.create", objectKind: "alignment", handle: created.handle, curve: index + 1, groups,
        property: "radius", aiValue: curve.radius, conditions },
      ...(curve.spiralLength ? [{ source: "create" as const, check: "alignment.create", objectKind: "alignment" as const, handle: created.handle,
        curve: index + 1, groups, property: "spiralLength" as const, aiValue: curve.spiralLength, conditions }] : [])
    ]);
  }
  const input = fix.source.check === "none" ? {} : fix.source.input as Record<string, unknown>;
  const conditions: TrackConditions = Object.fromEntries(["designSpeed", "roadClass", "region", "criteria"]
    .filter(key => input[key] !== undefined).map(key => [key, input[key]]));
  const curve = Number(/^곡선 (\d+)/.exec(fix.target)?.[1]);
  return (result.changes ?? []).flatMap((change, index): NewItem[] => {
    const handle = fix.changes[index]?.object.handle;
    if (!handle) return [];
    const base = { source: "fix" as const, check: fix.check, handle, aiValue: change.after, conditions };
    if (change.kind === "alignmentArc" && change.property === "radius" && curve > 0)
      return [{ ...base, objectKind: "alignment", curve, property: "radius" }];
    if (change.kind === "profilePvi" && change.property === "elevation")
      return [{ ...base, objectKind: "profile", at: change.at, property: "elevation" }];
    if (change.kind === "profileCurve" && change.property === "length")
      return [{ ...base, objectKind: "profile", at: change.at, property: "curveLength" }];
    return [];
  });
}

// After a successful apply: watch the values, and remember the drawing's name as a word never to send.
export async function trackApplied(fix: StoredFix, result: ChangeLogEntry["result"]): Promise<void> {
  if (!result) return;
  try {
    const scope = await currentDrawingScope();
    await addTerms([scope.label, ...(result.created && !/^선형-\d+$/.test(result.created.name) ? [result.created.name] : [])]);
    await track(scope, trackedItems(fix, result));
  } catch (error) {
    process.stderr.write(`MyCivil3DMcp tracking failed: ${String(error)}\n`);
  }
}
