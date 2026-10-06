import type { AlignmentCurve } from "../../civil/types/AlignmentCurve.js";
import type { AlignmentElement } from "../../civil/types/AlignmentElement.js";
import type { FixOption } from "../types/FixOption.js";
import { arcExternal, arcLength, arcTangent, ceilTo, curveTangent, radians, round, spiralShift } from "../../geometry.js";

export type CurveContext = { handle: string; curve: AlignmentCurve; elements: AlignmentElement[] };

// The curve group's elements and the straight lengths on each side, which a
// longer tangent can use without reaching the neighbouring curve.
function layout({ curve, elements }: CurveContext) {
  const group = elements.filter(element => element.curveGroup === curve.number).sort((a, b) => a.order - b.order);
  const arcs = group.filter(element => element.kind === "Arc");
  const before = elements.find(element => element.order === (group[0]?.order ?? -2) - 1);
  const after = elements.find(element => element.order === (group.at(-1)?.order ?? -2) + 1);
  return {
    group, arcs,
    simpleArc: group.length === 1 && arcs.length === 1 ? arcs[0] : undefined,
    room: { before: before?.kind === "Line" ? before.length : 0, after: after?.kind === "Line" ? after.length : 0 }
  };
}

function tangentCheck(fix: FixOption, growth: number, room: { before: number; after: number }): FixOption {
  if (growth > room.before || growth > room.after) {
    fix.status = "conflict";
    fix.reason = `접선장이 ${round(growth)} m 늘어나는데 앞 직선 ${round(room.before)} m, 뒤 직선 ${round(room.after)} m라 인접 곡선과 겹침`;
  }
  return fix;
}

// A larger radius at the same deflection angle. For a single arc the new tangent
// length is checked against the straights on both sides.
function largerRadius(context: CurveContext, radius: number, title: string): FixOption {
  const { simpleArc, arcs, room } = layout(context);
  const target = ceilTo(radius);
  if (!simpleArc || simpleArc.radius === undefined || simpleArc.deltaDeg === undefined) {
    return {
      title,
      changes: arcs.map(arc => ({ object: { kind: "alignmentArc" as const, handle: context.handle, at: arc.startStation }, property: "radius", from: arc.radius, to: target, unit: "m" })),
      status: "unverified",
      reason: "완화곡선이 있는 곡선은 접선장 변화를 계산하지 않음. 완화곡선 파라미터 A도 함께 바뀜",
      effects: []
    };
  }
  const delta = Math.abs(simpleArc.deltaDeg);
  const before = simpleArc.tangent ?? arcTangent(simpleArc.radius, delta);
  const after = arcTangent(target, delta);
  return tangentCheck({
    title,
    changes: [{ object: { kind: "alignmentArc", handle: context.handle, at: simpleArc.startStation }, property: "radius", from: round(simpleArc.radius), to: target, unit: "m" }],
    status: "feasible",
    effects: [
      `교각 ${round(delta, 4)}° 유지`,
      `접선장 T ${round(before)} → ${round(after)} m`,
      `곡선 길이 ${round(simpleArc.length)} → ${round(arcLength(target, delta))} m`,
      `외할 E ${round(simpleArc.external ?? arcExternal(simpleArc.radius, delta))} → ${round(arcExternal(target, delta))} m (계산값)`
    ]
  }, after - before, room);
}

// 제19조: radius below the minimum.
export function radiusFixes(context: CurveContext, minRadius: number): FixOption[] {
  return [largerRadius(context, minRadius, "곡선 반지름 키우기 (교각 유지)")];
}

// 제20조: curve too short. At the same deflection angle only a larger radius lengthens a single arc.
export function curveLengthFixes(context: CurveContext, minLength: number): FixOption[] {
  const { simpleArc } = layout(context);
  if (!simpleArc?.deltaDeg) return [];
  return [largerRadius(context, minLength / radians(Math.abs(simpleArc.deltaDeg)), "곡선 길이 늘리기 (반지름 키움, 교각 유지)")];
}

// 제23조①: a spiral is required but missing. Clothoids of the minimum length go on both
// sides; each takes Ls/(2R) of the deflection angle and shifts the arc inward by p (geometry.ts).
export function addSpiralFixes(context: CurveContext, minSpiral: number): FixOption[] {
  const { simpleArc, room } = layout(context);
  if (!simpleArc?.radius || simpleArc.deltaDeg === undefined) return [];
  const radius = simpleArc.radius;
  const delta = Math.abs(simpleArc.deltaDeg);
  const length = ceilTo(minSpiral);
  const parameter = ceilTo(Math.sqrt(radius * length));
  const shift = spiralShift(radius, length);
  const growth = curveTangent({ radius, spiral: length }, radians(delta)) - curveTangent({ radius, spiral: 0 }, radians(delta));
  const spiralAngle = length / radius * 180 / Math.PI;
  const fix: FixOption = {
    title: "완화곡선 추가 (양쪽 클로소이드)",
    changes: [
      { object: { kind: "alignmentSpiral", handle: context.handle, at: simpleArc.startStation }, property: "spiralInLength", to: length, unit: "m" },
      { object: { kind: "alignmentSpiral", handle: context.handle, at: simpleArc.endStation }, property: "spiralOutLength", to: length, unit: "m" }
    ],
    status: "feasible",
    effects: [
      `완화곡선 길이 ${length} m, 파라미터 A ${parameter} (R ${round(radius)} 유지)`,
      `이정량 p ${round(shift)} m, 접선장 약 ${round(growth)} m 증가 (근사 계산값)`,
      `원곡선 교각 ${round(delta, 4)}° → ${round(delta - spiralAngle, 4)}°`
    ]
  };
  if (spiralAngle >= delta) {
    fix.status = "conflict";
    fix.reason = `교각 ${round(delta, 4)}°가 완화곡선 두 개의 각 ${round(spiralAngle, 4)}°보다 작아 원곡선이 남지 않음`;
    return [fix];
  }
  return [tangentCheck(fix, growth, room)];
}

// 제23조②: spiral too short. Keeping the radius, A = √(R·Ls).
export function spiralLengthFixes(context: CurveContext, spiral: AlignmentElement, minSpiral: number): FixOption[] {
  const radius = layout(context).arcs[0]?.radius;
  const length = ceilTo(minSpiral);
  return [{
    title: "완화곡선 길이 늘리기",
    changes: [{ object: { kind: "alignmentSpiral", handle: context.handle, at: spiral.startStation }, property: "length", from: round(spiral.length), to: length, unit: "m" }],
    status: "unverified",
    reason: "완화곡선이 길어지면 원곡선 길이와 접선장이 함께 바뀜",
    effects: radius ? [`파라미터 A ${spiral.spiralA ? round(spiral.spiralA, 1) : "?"} → ${ceilTo(Math.sqrt(radius * length))} (R ${round(radius)} 유지, 계산값)`] : []
  }];
}

// 제21조①: superelevation above the maximum is a setting, not geometry.
export function superelevationFixes(handle: string, actual: number, limit: number): FixOption[] {
  return [{
    title: "최대 편경사 낮추기",
    changes: [{ object: { kind: "alignment", handle }, property: "maxSuperelevation", from: round(actual, 2), to: limit, unit: "%" }],
    status: "unverified",
    reason: "편경사 설정(설계 기준)에서 최대 편경사를 바꾸고 편경사를 다시 계산해야 함. 같은 곡선 반지름에서 필요한 최소 반지름이 커질 수 있음",
    effects: []
  }];
}
