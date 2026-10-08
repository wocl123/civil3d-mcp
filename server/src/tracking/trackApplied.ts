import { drawingContext } from "../bridge/drawingContext.js";
// 도면 변경이 적용된 직후: 무엇을 추적할지 정하고 추적을 시작한다.

import { readRecord } from "../civil/alignmentRecord.js";
import type { ChangeLogEntry } from "../changes/types/ChangeLogEntry.js";
import type { StoredFix } from "../changes/types/StoredFix.js";
import { addTerms } from "../data/terms.js";
import { currentDrawingScope } from "../memory/drawingScope.js";
import { track, type TrackConditions, type Tracked } from "./tracker.js";

type NewItem = Omit<Tracked, "id" | "lastValue" | "createdAt">;

// 적용된 수정안이나 만든 선형에서 지켜볼 값과, 그 값을 정한 설계 조건(관리자 PC가 조건별로 비교한다).
export function trackedItems(fix: StoredFix, result: NonNullable<ChangeLogEntry["result"]>): NewItem[] {
  // ── 만든 선형: 곡선마다 반지름과(있으면) 완화곡선 길이.
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

    return created.curves.flatMap((curve, index): NewItem[] => {
      const base = {
        source: "create" as const, check: "alignment.create", objectKind: "alignment" as const,
        handle: created.handle, curve: index + 1, groups, conditions
      };
      return [
        { ...base, property: "radius", aiValue: curve.radius },
        ...(curve.spiralLength ? [{ ...base, property: "spiralLength" as const, aiValue: curve.spiralLength }] : [])
      ];
    });
  }

  // ── 수정안: 검토에 쓴 조건 중 아는 것만.
  // 속성 변경·삭제는 설계 값이 아니라 추적하지 않는다.
  if (fix.edit || fix.remove || !Array.isArray(result.changes)) return [];
  const input = fix.source.check === "none" ? {} : fix.source.input as Record<string, unknown>;
  const conditions: TrackConditions = Object.fromEntries(["designSpeed", "roadClass", "region", "criteria"]
    .filter(key => input[key] !== undefined)
    .map(key => [key, input[key]]));

  // 반지름이 바뀌면 곡선 측점이 움직이므로 곡선은 번호("곡선 N")로 찾는다.
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

// 적용에 성공한 뒤: 값을 추적하고, 도면 이름(과 사람이 붙인 선형 이름)을 보내지 않을 낱말로 기억한다.
export async function trackApplied(fix: StoredFix, result: ChangeLogEntry["result"]): Promise<void> {
  if (!result) return;
  try {
    const scope = await currentDrawingScope();
    const expected = drawingContext();
    if (expected && (scope.drawingId !== expected.drawingId || scope.state !== expected.revision))
      throw new Error("Drawing changed before tracking was recorded.");
    const createdName = result.created && !/^선형-\d+$/.test(result.created.name) ? [result.created.name] : [];
    await addTerms([scope.label, ...createdName]);
    await track(scope, trackedItems(fix, result));
  } catch (error) {
    process.stderr.write(`MyCivil3DMcp tracking failed: ${String(error)}\n`);
  }
}
