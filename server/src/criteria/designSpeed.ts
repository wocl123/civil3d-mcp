// 설계속도 관련 계산: 측점별 설계속도, 도로 구분·지역별 기준 속도(제8조).

import type { AlignmentDesignSpeed } from "../civil/types/AlignmentDesignSpeed.js";
import { APARTMENT_ROAD, type Region, type RoadClass } from "../civil/alignmentRecord.js";
import { findRow, table } from "./criteriaStore.js";
import { label } from "./reportBuilder.js";
import type { CriteriaSet } from "./types/CriteriaSet.js";

// 어떤 측점의 설계속도.
// 질문에서 준 값이 있으면 그것을, 없으면 선형의 설계속도 목록에서 그 측점에 적용되는 값을 쓴다
// (각 항목은 다음 항목이 시작될 때까지 적용된다).
export function speedAt(station: number, given: number | undefined, speeds: AlignmentDesignSpeed[]):
  { value: number; from: "input" | "drawing" } | undefined {
  if (given !== undefined) return { value: given, from: "input" };

  const sorted = [...speeds].sort((a, b) => a.station - b.station);
  const entry = sorted.filter(item => item.station <= station + 1e-6).at(-1) ?? sorted[0];
  return entry ? { value: entry.speed, from: "drawing" } : undefined;
}

// 선형의 설계속도 목록을 한 줄로: "선형 설계속도: 0+000.00부터 60, 1+200.00부터 50".
export function describeSpeeds(given: number | undefined, speeds: AlignmentDesignSpeed[]): string | undefined {
  if (given !== undefined) return undefined;
  if (speeds.length === 0) return undefined;
  return "선형 설계속도: " + speeds.map(item => `${item.stationText}부터 ${item.speed}`).join(", ");
}

// 제8조① 도로 구분·지역의 기준 설계속도.
//   standard: 표 값
//   lowest:   단서로 낮출 수 있는 최저값(표 값 − relax)
//   highest:  상한이 있는 경우(공동주택 단지 내 도로: LH 지침 8.1.3 나, 20 km/h)
export type SpeedLimits = { standard: number; lowest: number; highest?: number; label: string };

export function designSpeedLimits(set: CriteriaSet, roadClass: RoadClass, region: Region): SpeedLimits {
  // 공동주택 단지 내 도로는 그 표가 있는 기준(LH 지침)에서만 알 수 있다.
  if (roadClass === APARTMENT_ROAD) {
    const source = set.tables.find(item => item.id === "apartment_road_speed");
    if (!source || typeof source.rows[0]?.value !== "number")
      throw new Error(`${set.title}에는 공동주택 단지 내 도로 설계속도 기준이 없다. LH_설계지침_토목 기준에서 쓴다.`);
    return { standard: source.rows[0].value, lowest: 10, highest: source.rows[0].value, label: label(source) };
  }

  const source = table(set, "design_speed");
  const row = findRow(source, { roadClass, region });
  if (typeof row?.value !== "number") throw new Error(`${label(source)} 표에 ${roadClass}, ${region} 행이 없다.`);
  return { standard: row.value, lowest: row.value - (source.relax ?? 0), label: label(source) };
}
