import type { ProfileCurve } from "../../civil/types/ProfileCurve.js";
import type { ProfilePvi } from "../../civil/types/ProfilePvi.js";
import type { ProfileSummary } from "../../civil/types/ProfileSummary.js";
import type { ProfileTangent } from "../../civil/types/ProfileTangent.js";
import type { FixOption } from "../types/FixOption.js";
import { ceilTo, floorTo, round, station } from "./geometry.js";

export type VerticalCurveContext = {
  profile: ProfileSummary; curve: ProfileCurve; curves: ProfileCurve[]; pvis: ProfilePvi[];
  minK: number; minLength: number;
};

// Fixes for a vertical curve whose K or length is below the criteria:
// a longer curve at the same PVI, or a smaller grade change by moving the PVI elevation.
export function verticalCurveFixes(context: VerticalCurveContext): FixOption[] {
  const { curve } = context;
  const change = curve.gradeChangePercent === undefined ? undefined : Math.abs(curve.gradeChangePercent);
  if (!change) return [];
  return [longerCurve(context, change), smallerGradeChange(context, change)].filter((fix): fix is FixOption => fix !== undefined);
}

function longerCurve(context: VerticalCurveContext, change: number): FixOption {
  const { profile, curve, curves, minK, minLength } = context;
  const required = ceilTo(Math.max(minK * change, minLength));
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
    changes: [{ object: { kind: "profileCurve", handle: profile.handle, at: curve.pviStation }, property: "length", from: round(curve.length), to: required, unit: "m" }],
    status: "feasible",
    effects: [
      `곡선 구간 ${station(curve.pviStation - required / 2)}~${station(curve.pviStation + required / 2)}`,
      `K ${round(curve.k ?? curve.length / change, 1)} → ${round(required / change, 1)}`,
      `VIP 수직거리 ${round(change * curve.length / 800)} → ${round(change * required / 800)} m (계산값)`
    ]
  };
  if (curve.curveType === "ParabolaAsymmetric") {
    fix.status = "unverified";
    fix.reason = "비대칭 곡선은 VIP 앞뒤 길이를 따로 정해야 함";
  } else if (required > longest) {
    fix.status = "conflict";
    fix.reason = `${previous ? `앞 곡선 끝(${previous.endStationText})` : "종단 시점"}까지 ${round(room.before)} m, ` +
      `${next ? `뒤 곡선 시작(${next.startStationText})` : "종단 종점"}까지 ${round(room.after)} m라 VIP를 유지한 대칭 곡선은 최대 ${longest} m`;
  }
  return fix;
}

// Moving the PVI elevation by d changes both grades; the grade change falls by
// 100·d·(1/a + 1/b), where a and b are the distances to the neighbouring PVIs.
function smallerGradeChange(context: VerticalCurveContext, change: number): FixOption | undefined {
  const { profile, curve, curves, pvis, minK, minLength } = context;
  if (curve.length < minLength) return undefined;
  const index = pvis.findIndex(pvi => Math.abs(pvi.station - curve.pviStation) < 0.01);
  const [previous, pvi, next] = [pvis[index - 1], pvis[index], pvis[index + 1]];
  if (!previous || !pvi || !next) return undefined;
  const a = pvi.station - previous.station;
  const b = next.station - pvi.station;
  const target = curve.length / minK;
  const shift = ceilTo((change - target) / (100 * (1 / a + 1 / b)), 0.001);
  const crest = curve.crestOrSag === "Crest";
  const elevation = round(pvi.elevation + (crest ? -shift : shift));
  const gradeIn = (elevation - previous.elevation) / a * 100;
  const gradeOut = (next.elevation - elevation) / b * 100;
  const newChange = Math.abs(gradeOut - gradeIn);
  // The neighbouring PVIs keep their elevation, but their curves get a new grade on this side.
  const neighbours = [{ pvi: previous, grade: gradeIn, side: "out" as const }, { pvi: next, grade: gradeOut, side: "in" as const }]
    .flatMap(({ pvi: other, grade, side }) => {
      const neighbour = curves.find(item => Math.abs(item.pviStation - other.station) < 0.01);
      if (!neighbour || neighbour.gradeInPercent === undefined || neighbour.gradeOutPercent === undefined) return [];
      const changed = Math.abs(side === "out" ? neighbour.gradeInPercent - grade : grade - neighbour.gradeOutPercent);
      return [`인접 곡선 VIP ${neighbour.pviStationText}: 경사 차 ${round(Math.abs(neighbour.gradeChangePercent ?? 0), 2)} → ${round(changed, 2)}%, ` +
        `K ${round(neighbour.k ?? 0, 1)} → ${round(neighbour.length / changed, 1)} (계산값)`];
    });
  return {
    title: "경사 차 줄이기 (곡선 길이 유지, VIP 표고 조정)",
    changes: [{ object: { kind: "profilePvi", handle: profile.handle, at: pvi.station }, property: "elevation", from: round(pvi.elevation), to: elevation, unit: "m" }],
    status: "unverified",
    reason: `앞뒤 VIP(${previous.stationText}, ${next.stationText})로 이어지는 경사가 바뀌어 그 곡선들은 다시 검토해야 함`,
    effects: [
      `VIP 표고 ${crest ? "낮춤" : "높임"} ${shift.toFixed(3)} m`,
      `경사 ${round(curve.gradeInPercent ?? 0, 2)}% → ${round(gradeIn, 2)}%, ${round(curve.gradeOutPercent ?? 0, 2)}% → ${round(gradeOut, 2)}%`,
      `경사 차 ${round(change, 2)} → ${round(newChange, 2)}%, K ${round(curve.length / newChange, 1)} (계산값)`,
      ...neighbours
    ]
  };
}

// A grade steeper than the criteria: the PVIs at its ends must come closer in elevation.
export function gradeFixes(profile: ProfileSummary, tangent: ProfileTangent, pvis: ProfilePvi[], limit: number): FixOption[] {
  if (tangent.gradePercent === undefined) return [];
  const start = [...pvis].reverse().find(pvi => pvi.station <= tangent.startStation + 1e-6);
  const end = pvis.find(pvi => pvi.station >= tangent.endStation - 1e-6);
  const span = start && end ? end.station - start.station : tangent.length;
  const drop = (Math.abs(tangent.gradePercent) - limit) / 100 * span;
  const sign = Math.sign(tangent.gradePercent);
  return [{
    title: "종단경사 낮추기",
    changes: [{ object: { kind: "profileTangent", handle: profile.handle, at: tangent.startStation }, property: "gradePercent", from: round(tangent.gradePercent, 2), to: sign * limit, unit: "%" }],
    status: "unverified",
    reason: "경사 양 끝 VIP 표고를 조정해야 하며 앞뒤 경사와 종단곡선이 함께 바뀜",
    effects: [`${start && end ? `VIP ${start.stationText}~${end.stationText}` : "경사 구간"} ${round(span)} m 사이 표고 차를 ${round(drop)} m 줄여야 함 (계산값)`]
  }];
}
