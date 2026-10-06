// 종단 기준 미달 항목의 수정안 계산(종단곡선 K·길이, 종단경사).
// 상태(feasible / conflict / unverified)의 뜻은 alignmentFixes.ts 와 같다.

import type { ProfileCurve } from "../../civil/types/ProfileCurve.js";
import type { ProfilePvi } from "../../civil/types/ProfilePvi.js";
import type { ProfileSummary } from "../../civil/types/ProfileSummary.js";
import type { ProfileTangent } from "../../civil/types/ProfileTangent.js";
import type { FixOption } from "../types/FixOption.js";
import { step } from "../../knowledge/parameters.js";
import { ceilTo, floorTo, round, station } from "../../geometry.js";

export type VerticalCurveContext = {
  profile: ProfileSummary;
  curve: ProfileCurve;
  curves: ProfileCurve[];
  pvis: ProfilePvi[];
  minK: number;
  minLength: number;
};

// K나 길이가 모자란 종단곡선의 수정안 두 가지:
//   ① 같은 VIP에서 곡선을 길게
//   ② VIP 표고를 옮겨 경사 차를 줄이기
export function verticalCurveFixes(context: VerticalCurveContext): FixOption[] {
  const { curve } = context;
  const change = curve.gradeChangePercent === undefined ? undefined : Math.abs(curve.gradeChangePercent);
  if (!change) return [];
  return [longerCurve(context, change), smallerGradeChange(context, change)]
    .filter((fix): fix is FixOption => fix !== undefined);
}

// ① 곡선 길이를 필요 길이로 늘린다. 앞뒤 곡선(또는 종단 시점·종점)까지의 여유를 확인한다.
function longerCurve(context: VerticalCurveContext, change: number): FixOption {
  const { profile, curve, curves, minK, minLength } = context;

  // 필요 길이 = max(K × 경사 차, 최소 길이), 승인된 올림 단위가 있으면 그 단위로 올림.
  const notes: string[] = [];
  const required = ceilTo(Math.max(minK * change, minLength), step("profile.curveLengthStep", 1, notes));

  // VIP에서 앞뒤 곡선까지의 여유. 대칭 곡선은 짧은 쪽의 2배까지만 길어질 수 있다.
  const sorted = [...curves].sort((a, b) => a.pviStation - b.pviStation);
  const index = sorted.findIndex(item => item.number === curve.number);
  const previous = sorted[index - 1];
  const next = sorted[index + 1];
  const room = {
    before: curve.pviStation - (previous ? previous.endStation : profile.startStation),
    after: (next ? next.startStation : profile.endStation) - curve.pviStation
  };
  const longest = floorTo(2 * Math.min(room.before, room.after));

  const fix: FixOption = {
    title: "종단곡선 길이 늘리기 (VIP 유지)",
    changes: [{
      object: { kind: "profileCurve", handle: profile.handle, at: curve.pviStation },
      property: "length", from: round(curve.length), to: required, unit: "m"
    }],
    status: "feasible",
    effects: [
      `곡선 구간 ${station(curve.pviStation - required / 2)}~${station(curve.pviStation + required / 2)}`,
      `K ${round(curve.k ?? curve.length / change, 1)} → ${round(required / change, 1)}`,
      `VIP 수직거리 ${round(change * curve.length / 800)} → ${round(change * required / 800)} m (계산값)`,
      ...notes
    ]
  };

  if (curve.curveType === "ParabolaAsymmetric") {
    fix.status = "unverified";
    fix.reason = "비대칭 곡선은 VIP 앞뒤 길이를 따로 정해야 함";
  } else if (required > longest) {
    fix.status = "conflict";
    fix.reason =
      `${previous ? `앞 곡선 끝(${previous.endStationText})` : "종단 시점"}까지 ${round(room.before)} m, ` +
      `${next ? `뒤 곡선 시작(${next.startStationText})` : "종단 종점"}까지 ${round(room.after)} m라 ` +
      `VIP를 유지한 대칭 곡선은 최대 ${longest} m`;
  }
  return fix;
}

// ② VIP 표고를 d만큼 옮기면 앞뒤 경사가 함께 바뀌고,
//    경사 차는 100·d·(1/a + 1/b) 만큼 줄어든다(a, b: 앞뒤 VIP까지의 거리).
//    곡선 길이가 최소 길이 이상일 때만 의미가 있다(K만 모자란 경우).
function smallerGradeChange(context: VerticalCurveContext, change: number): FixOption | undefined {
  const { profile, curve, curves, pvis, minK, minLength } = context;
  if (curve.length < minLength) return undefined;

  // 이 곡선의 VIP와 그 앞뒤 VIP.
  const index = pvis.findIndex(pvi => Math.abs(pvi.station - curve.pviStation) < 0.01);
  const [previous, pvi, next] = [pvis[index - 1], pvis[index], pvis[index + 1]];
  if (!previous || !pvi || !next) return undefined;

  // 목표 경사 차 = 현재 길이 ÷ 최소 K. 거기에 맞는 표고 이동량.
  const a = pvi.station - previous.station;
  const b = next.station - pvi.station;
  const target = curve.length / minK;
  const shift = ceilTo((change - target) / (100 * (1 / a + 1 / b)), 0.001);

  // 볼록 곡선은 VIP를 낮추고, 오목 곡선은 높인다.
  const crest = curve.crestOrSag === "Crest";
  const elevation = round(pvi.elevation + (crest ? -shift : shift));
  const gradeIn = (elevation - previous.elevation) / a * 100;
  const gradeOut = (next.elevation - elevation) / b * 100;
  const newChange = Math.abs(gradeOut - gradeIn);

  // 앞뒤 VIP의 표고는 그대로지만, 그 곡선들의 이쪽 경사가 바뀐다. 바뀐 경사 차와 K를 알린다.
  const neighbours = [
    { pvi: previous, grade: gradeIn, side: "out" as const },
    { pvi: next, grade: gradeOut, side: "in" as const }
  ].flatMap(({ pvi: other, grade, side }) => {
    const neighbour = curves.find(item => Math.abs(item.pviStation - other.station) < 0.01);
    if (!neighbour || neighbour.gradeInPercent === undefined || neighbour.gradeOutPercent === undefined) return [];
    const changed = Math.abs(side === "out" ? neighbour.gradeInPercent - grade : grade - neighbour.gradeOutPercent);
    return [
      `인접 곡선 VIP ${neighbour.pviStationText}: 경사 차 ${round(Math.abs(neighbour.gradeChangePercent ?? 0), 2)} → ${round(changed, 2)}%, ` +
      `K ${round(neighbour.k ?? 0, 1)} → ${round(neighbour.length / changed, 1)} (계산값)`
    ];
  });

  return {
    title: "경사 차 줄이기 (곡선 길이 유지, VIP 표고 조정)",
    changes: [{
      object: { kind: "profilePvi", handle: profile.handle, at: pvi.station },
      property: "elevation", from: round(pvi.elevation), to: elevation, unit: "m"
    }],
    status: "unverified",
    reason: `앞뒤 VIP(${previous.stationText}, ${next.stationText})로 이어지는 경사가 바뀌어 그 곡선들은 다시 검토해야 함`,
    effects: [
      `VIP 표고 ${crest ? "낮춤" : "높임"} ${shift.toFixed(3)} m`,
      `경사 ${round(curve.gradeInPercent ?? 0, 2)}% → ${round(gradeIn, 2)}%, ` +
        `${round(curve.gradeOutPercent ?? 0, 2)}% → ${round(gradeOut, 2)}%`,
      `경사 차 ${round(change, 2)} → ${round(newChange, 2)}%, K ${round(curve.length / newChange, 1)} (계산값)`,
      ...neighbours
    ]
  };
}

// 종단경사가 기준보다 급하다 → 경사 양 끝 VIP의 표고 차를 줄여야 한다.
export function gradeFixes(profile: ProfileSummary, tangent: ProfileTangent, pvis: ProfilePvi[], limit: number): FixOption[] {
  if (tangent.gradePercent === undefined) return [];

  // 경사 구간 양 끝의 VIP(없으면 경사 길이 자체를 쓴다).
  const start = [...pvis].reverse().find(pvi => pvi.station <= tangent.startStation + 1e-6);
  const end = pvis.find(pvi => pvi.station >= tangent.endStation - 1e-6);
  const span = start && end ? end.station - start.station : tangent.length;

  // 줄여야 할 표고 차 = (현재 경사 − 기준) × 구간 길이.
  const drop = (Math.abs(tangent.gradePercent) - limit) / 100 * span;
  const sign = Math.sign(tangent.gradePercent);
  const where = start && end ? `VIP ${start.stationText}~${end.stationText}` : "경사 구간";

  return [{
    title: "종단경사 낮추기",
    changes: [{
      object: { kind: "profileTangent", handle: profile.handle, at: tangent.startStation },
      property: "gradePercent", from: round(tangent.gradePercent, 2), to: sign * limit, unit: "%"
    }],
    status: "unverified",
    reason: "경사 양 끝 VIP 표고를 조정해야 하며 앞뒤 경사와 종단곡선이 함께 바뀜",
    effects: [`${where} ${round(span)} m 사이 표고 차를 ${round(drop)} m 줄여야 함 (계산값)`]
  }];
}
