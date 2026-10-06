import type { DesignChange } from "../criteria/types/DesignChange.js";
import { station } from "../criteria/fixes/geometry.js";
import type { AlignmentCreateRequest } from "../design/types/AlignmentLayout.js";

// Kinds and properties the plug-in can apply (DesignChanges.cs). Others stay suggestions.
const SUPPORTED = new Set(["profilePvi.elevation", "profileCurve.length", "alignmentArc.radius"]);

export function supported(change: DesignChange): boolean {
  return SUPPORTED.has(`${change.object.kind}.${change.property}`);
}

const NAMES: Record<string, (at: string) => string> = {
  "profilePvi.elevation": at => `VIP ${at} 표고`,
  "profileCurve.length": at => `VIP ${at} 종단곡선 길이`,
  "alignmentArc.radius": at => `${at} 시작 원곡선 반지름`
};

// "선형 선형-1 생성 (도로 중심선, 곡선 3개, 완화곡선 50 m)"
export function describeCreate(create: AlignmentCreateRequest): string {
  const curves = create.curves.filter(curve => curve.radius);
  const spiral = curves.find(curve => curve.spiralLength)?.spiralLength;
  return `선형 ${create.name} 생성 (${create.description}, 곡선 ${curves.length}개${spiral ? `, 완화곡선 ${spiral} m` : ""})`;
}

// "VIP 0+420.00 종단곡선 길이 160 → 172 m"
export function describe(change: DesignChange): string {
  const at = change.object.at === undefined ? "" : station(change.object.at);
  const name = NAMES[`${change.object.kind}.${change.property}`]?.(at) ?? `${change.object.kind} ${change.property}`;
  return `${name} ${change.from ?? "?"} → ${change.to} ${change.unit}`;
}
