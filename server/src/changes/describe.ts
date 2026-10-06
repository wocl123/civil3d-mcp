// 도면 변경을 사람이 읽는 한 줄로 쓴다. 팔레트의 "도면 수정 적용됨" 표시와 변경 기록에 쓴다.

import type { DesignChange } from "../criteria/types/DesignChange.js";
import { station } from "../geometry.js";
import type { AlignmentCreateRequest } from "../design/types/AlignmentLayout.js";

// 플러그인이 자동 적용할 수 있는 변경(DesignChanges.cs). 나머지는 제안으로만 남는다.
const SUPPORTED = new Set(["profilePvi.elevation", "profileCurve.length", "alignmentArc.radius"]);

export function supported(change: DesignChange): boolean {
  return SUPPORTED.has(`${change.object.kind}.${change.property}`);
}

// 변경 대상의 이름(at: 측점 문자열).
const NAMES: Record<string, (at: string) => string> = {
  "profilePvi.elevation": at => `VIP ${at} 표고`,
  "profileCurve.length": at => `VIP ${at} 종단곡선 길이`,
  "alignmentArc.radius": at => `${at} 시작 원곡선 반지름`
};

// 예: "선형 선형-1 생성 (용도: 도로 / ..., 곡선 3개, 완화곡선 50 m)"
export function describeCreate(create: AlignmentCreateRequest): string {
  const curves = create.curves.filter(curve => curve.radius);
  const spiral = curves.find(curve => curve.spiralLength)?.spiralLength;
  return `선형 ${create.name} 생성 (${create.description}, 곡선 ${curves.length}개${spiral ? `, 완화곡선 ${spiral} m` : ""})`;
}

// 예: "VIP 0+420.00 종단곡선 길이 160 → 172 m"
export function describe(change: DesignChange): string {
  const at = change.object.at === undefined ? "" : station(change.object.at);
  const name = NAMES[`${change.object.kind}.${change.property}`]?.(at) ?? `${change.object.kind} ${change.property}`;
  return `${name} ${change.from ?? "?"} → ${change.to} ${change.unit}`;
}
