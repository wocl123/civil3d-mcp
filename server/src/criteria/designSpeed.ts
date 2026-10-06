import type { AlignmentDesignSpeed } from "../civil/types/AlignmentDesignSpeed.js";
import { APARTMENT_ROAD, type Region, type RoadClass } from "../design/alignmentRecord.js";
import { findRow, table } from "./criteriaStore.js";
import { label } from "./reportBuilder.js";
import type { CriteriaSet } from "./types/CriteriaSet.js";

// The design speed at a station: the given speed, otherwise the alignment's design
// speed entry in effect there (each entry applies until the next one).
export function speedAt(station: number, given: number | undefined, speeds: AlignmentDesignSpeed[]):
  { value: number; from: "input" | "drawing" } | undefined {
  if (given !== undefined) return { value: given, from: "input" };
  const sorted = [...speeds].sort((a, b) => a.station - b.station);
  const entry = sorted.filter(item => item.station <= station + 1e-6).at(-1) ?? sorted[0];
  return entry ? { value: entry.speed, from: "drawing" } : undefined;
}

export function describeSpeeds(given: number | undefined, speeds: AlignmentDesignSpeed[]): string | undefined {
  if (given !== undefined) return undefined;
  if (speeds.length === 0) return undefined;
  return "선형 설계속도: " + speeds.map(item => `${item.stationText}부터 ${item.speed}`).join(", ");
}

// The design speed 제8조① gives for a road class and area, and the lowest its proviso
// allows (표 값 − relax). Roads inside housing estates take the LH manual's 20 km/h
// ceiling (8.1.3 나) instead; only sets with that table know them.
export type SpeedLimits = { standard: number; lowest: number; highest?: number; label: string };

export function designSpeedLimits(set: CriteriaSet, roadClass: RoadClass, region: Region): SpeedLimits {
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
