// 평면선형 기준 미달 항목의 수정안 계산.
// 수정안은 코드가 계산하고(바꿀 객체·속성·현재값·목표값), 상태를 붙인다.
//   feasible:   계산상 들어맞음
//   conflict:   인접 요소와 겹쳐 그대로는 안 됨(reason에 이유)
//   unverified: 다른 요소도 바뀌는데 코드가 다시 검토하지 않음

import type { AlignmentCurve } from "../../civil/types/AlignmentCurve.js";
import type { AlignmentElement } from "../../civil/types/AlignmentElement.js";
import type { FixOption } from "../types/FixOption.js";
import { step } from "../../knowledge/parameters.js";
import {
  arcExternal, arcLength, arcTangent, ceilTo, curveTangent, radians, round, spiralShift
} from "../../geometry.js";

export type CurveContext = { handle: string; curve: AlignmentCurve; elements: AlignmentElement[] };

// 곡선 그룹의 요소들과, 그 앞뒤 직선 길이.
// 접선장이 길어질 때 인접 곡선에 닿지 않고 쓸 수 있는 여유가 이 직선 길이다.
function layout({ curve, elements }: CurveContext) {
  const group = elements
    .filter(element => element.curveGroup === curve.number)
    .sort((a, b) => a.order - b.order);
  const arcs = group.filter(element => element.kind === "Arc");
  const before = elements.find(element => element.order === (group[0]?.order ?? -2) - 1);
  const after = elements.find(element => element.order === (group.at(-1)?.order ?? -2) + 1);

  return {
    group,
    arcs,
    // 완화곡선 없이 원곡선 하나로 된 곡선
    simpleArc: group.length === 1 && arcs.length === 1 ? arcs[0] : undefined,
    room: {
      before: before?.kind === "Line" ? before.length : 0,
      after: after?.kind === "Line" ? after.length : 0
    }
  };
}

// 접선장이 늘어나는 만큼 앞뒤 직선에 여유가 있는지. 없으면 conflict로 바꾼다.
function tangentCheck(fix: FixOption, growth: number, room: { before: number; after: number }): FixOption {
  if (growth > room.before || growth > room.after) {
    fix.status = "conflict";
    fix.reason = `접선장이 ${round(growth)} m 늘어나는데 앞 직선 ${round(room.before)} m, ` +
      `뒤 직선 ${round(room.after)} m라 인접 곡선과 겹침`;
  }
  return fix;
}

// 교각은 그대로 두고 반지름을 키운다.
// 원곡선 하나로 된 곡선이면 늘어난 접선장이 앞뒤 직선 안에 들어가는지 확인한다.
function largerRadius(context: CurveContext, radius: number, title: string): FixOption {
  const { simpleArc, arcs, room } = layout(context);

  // 반지름은 승인된 올림 단위(설정값)가 있으면 그 단위로 올린다.
  const notes: string[] = [];
  const target = ceilTo(radius, step("alignment.radiusStep", 1, notes));

  // 완화곡선이 있는 곡선: 바꿀 값만 제시하고 접선장 변화는 계산하지 않는다.
  if (!simpleArc || simpleArc.radius === undefined || simpleArc.deltaDeg === undefined) {
    return {
      title,
      changes: arcs.map(arc => ({
        object: { kind: "alignmentArc" as const, handle: context.handle, at: arc.startStation },
        property: "radius", from: arc.radius, to: target, unit: "m"
      })),
      status: "unverified",
      reason: "완화곡선이 있는 곡선은 접선장 변화를 계산하지 않음. 완화곡선 파라미터 A도 함께 바뀜",
      effects: notes
    };
  }

  const delta = Math.abs(simpleArc.deltaDeg);
  const before = simpleArc.tangent ?? arcTangent(simpleArc.radius, delta);
  const after = arcTangent(target, delta);

  return tangentCheck({
    title,
    changes: [{
      object: { kind: "alignmentArc", handle: context.handle, at: simpleArc.startStation },
      property: "radius", from: round(simpleArc.radius), to: target, unit: "m"
    }],
    status: "feasible",
    effects: [
      `교각 ${round(delta, 4)}° 유지`,
      `접선장 T ${round(before)} → ${round(after)} m`,
      `곡선 길이 ${round(simpleArc.length)} → ${round(arcLength(target, delta))} m`,
      `외할 E ${round(simpleArc.external ?? arcExternal(simpleArc.radius, delta))} → ${round(arcExternal(target, delta))} m (계산값)`,
      ...notes
    ]
  }, after - before, room);
}

// 제19조 반지름이 최소 반지름보다 작다 → 반지름 키우기.
export function radiusFixes(context: CurveContext, minRadius: number): FixOption[] {
  return [largerRadius(context, minRadius, "곡선 반지름 키우기 (교각 유지)")];
}

// 제20조 곡선 길이가 짧다.
// 교각이 같으면 원곡선을 길게 하는 방법은 반지름을 키우는 것뿐이다(L = R × 교각).
export function curveLengthFixes(context: CurveContext, minLength: number): FixOption[] {
  const { simpleArc } = layout(context);
  if (!simpleArc?.deltaDeg) return [];
  const radius = minLength / radians(Math.abs(simpleArc.deltaDeg));
  return [largerRadius(context, radius, "곡선 길이 늘리기 (반지름 키움, 교각 유지)")];
}

// 제23조① 완화곡선이 필요한데 없다 → 양쪽에 최소 길이 클로소이드를 넣는다.
// 클로소이드 하나가 교각의 Ls/(2R)을 차지하고, 원곡선을 이정량 p만큼 안쪽으로 민다(geometry.ts).
export function addSpiralFixes(context: CurveContext, minSpiral: number): FixOption[] {
  const { simpleArc, room } = layout(context);
  if (!simpleArc?.radius || simpleArc.deltaDeg === undefined) return [];

  const radius = simpleArc.radius;
  const delta = Math.abs(simpleArc.deltaDeg);
  const notes: string[] = [];
  const length = ceilTo(minSpiral, step("alignment.spiralStep", 1, notes));
  const parameter = ceilTo(Math.sqrt(radius * length));
  const shift = spiralShift(radius, length);
  const growth = curveTangent({ radius, spiral: length }, radians(delta)) - curveTangent({ radius, spiral: 0 }, radians(delta));
  const spiralAngle = length / radius * 180 / Math.PI;

  const fix: FixOption = {
    title: "완화곡선 추가 (양쪽 클로소이드)",
    changes: [
      {
        object: { kind: "alignmentSpiral", handle: context.handle, at: simpleArc.startStation },
        property: "spiralInLength", to: length, unit: "m"
      },
      {
        object: { kind: "alignmentSpiral", handle: context.handle, at: simpleArc.endStation },
        property: "spiralOutLength", to: length, unit: "m"
      }
    ],
    status: "feasible",
    effects: [
      `완화곡선 길이 ${length} m, 파라미터 A ${parameter} (R ${round(radius)} 유지)`,
      `이정량 p ${round(shift)} m, 접선장 약 ${round(growth)} m 증가 (근사 계산값)`,
      `원곡선 교각 ${round(delta, 4)}° → ${round(delta - spiralAngle, 4)}°`,
      ...notes
    ]
  };

  // 교각이 완화곡선 두 개의 각보다 작으면 원곡선이 남지 않는다.
  if (spiralAngle >= delta) {
    fix.status = "conflict";
    fix.reason = `교각 ${round(delta, 4)}°가 완화곡선 두 개의 각 ${round(spiralAngle, 4)}°보다 작아 원곡선이 남지 않음`;
    return [fix];
  }
  return [tangentCheck(fix, growth, room)];
}

// 제23조② 완화곡선이 짧다 → 길이를 늘린다. 반지름을 유지하면 A = √(R·Ls).
export function spiralLengthFixes(context: CurveContext, spiral: AlignmentElement, minSpiral: number): FixOption[] {
  const radius = layout(context).arcs[0]?.radius;
  const notes: string[] = [];
  const length = ceilTo(minSpiral, step("alignment.spiralStep", 1, notes));
  const parameterLine = radius
    ? [`파라미터 A ${spiral.spiralA ? round(spiral.spiralA, 1) : "?"} → ${ceilTo(Math.sqrt(radius * length))} (R ${round(radius)} 유지, 계산값)`]
    : [];

  return [{
    title: "완화곡선 길이 늘리기",
    changes: [{
      object: { kind: "alignmentSpiral", handle: context.handle, at: spiral.startStation },
      property: "length", from: round(spiral.length), to: length, unit: "m"
    }],
    status: "unverified",
    reason: "완화곡선이 길어지면 원곡선 길이와 접선장이 함께 바뀜",
    effects: radius ? [...parameterLine, ...notes] : notes
  }];
}

// 제21조① 편경사가 최대값을 넘는다. 형상이 아니라 편경사 설정을 바꿔야 한다.
export function superelevationFixes(handle: string, actual: number, limit: number): FixOption[] {
  return [{
    title: "최대 편경사 낮추기",
    changes: [{
      object: { kind: "alignment", handle },
      property: "maxSuperelevation", from: round(actual, 2), to: limit, unit: "%"
    }],
    status: "unverified",
    reason: "편경사 설정(설계 기준)에서 최대 편경사를 바꾸고 편경사를 다시 계산해야 함. " +
      "같은 곡선 반지름에서 필요한 최소 반지름이 커질 수 있음",
    effects: []
  }];
}
