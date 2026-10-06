import { callPlugin } from "../bridge/pluginClient.js";
import { readSection } from "../civil/civilData.js";
import type { AlignmentCurve } from "../civil/types/AlignmentCurve.js";
import type { AlignmentDesignSpeed } from "../civil/types/AlignmentDesignSpeed.js";
import type { AlignmentElement } from "../civil/types/AlignmentElement.js";
import type { AlignmentSuperelevation } from "../civil/types/AlignmentSuperelevation.js";
import { findRow, loadCriteria, options, table } from "./criteriaStore.js";
import { describeSpeeds, designSpeedLimits, speedAt } from "./designSpeed.js";
import { addSpiralFixes, curveLengthFixes, radiusFixes, spiralLengthFixes, superelevationFixes, type CurveContext } from "./fixes/alignmentFixes.js";
import { label, ReportBuilder } from "./reportBuilder.js";
import { APARTMENT_ROAD, notRoadNote, readRecord, superelevationArea, writeRecord, type Region, type RoadClass } from "../design/alignmentRecord.js";
import type { CriteriaSet } from "./types/CriteriaSet.js";
import type { CriteriaReport } from "./types/CriteriaReport.js";

export type AlignmentCriteriaInput = {
  alignment: string; criteria?: string;
  designSpeed?: number; maxSuperelevation?: number; area?: string;
  roadClass?: RoadClass; region?: Region;
};

export const SPIRAL_REQUIRED_FROM = 60;

// Compares an alignment's curves, spirals, and superelevation with a criteria set
// (by default 도로구조규칙 제8·19·20·21·23조). Conditions not given are taken from the
// drawing where possible (design speeds, and the criteria, road class, area, and maximum
// superelevation recorded in the alignment's description when it was created) or the
// criteria (maximum superelevation by area).
export async function checkAlignmentCriteria(given: AlignmentCriteriaInput): Promise<CriteriaReport> {
  const overview = await callPlugin("alignment.get", { alignment: given.alignment }) as
    { alignment: { name: string; handle: string; description?: string | null }; settings: { superelevationType: string } };
  const record = readRecord(overview.alignment.description);
  const recorded = (["roadClass", "region", "area", "maxSuperelevation"] as const)
    .filter(name => given[name] === undefined && record[name] !== undefined);
  const input: AlignmentCriteriaInput = {
    ...given, criteria: given.criteria ?? record.criteria,
    roadClass: given.roadClass ?? record.roadClass, region: given.region ?? record.region,
    area: given.area ?? record.area ?? superelevationArea(given.region ?? record.region),
    maxSuperelevation: given.maxSuperelevation ?? record.maxSuperelevation
  };
  const set = await loadCriteria(input.criteria ?? "도로구조규칙");
  const key = overview.alignment.handle;
  const notRoad = notRoadNote(record.uses);
  if (notRoad) {
    const skipped = new ReportBuilder(set, `선형 ${overview.alignment.name}`);
    skipped.notes.push(notRoad);
    return skipped.build();
  }
  const [curves, elements, speeds, superelevation] = await Promise.all([
    readSection<AlignmentCurve>("alignment.section", { alignment: key }, "curves"),
    readSection<AlignmentElement>("alignment.section", { alignment: key }, "elements"),
    readSection<AlignmentDesignSpeed>("alignment.section", { alignment: key }, "design_speeds"),
    readSection<AlignmentSuperelevation>("alignment.section", { alignment: key }, "superelevation")
  ]);

  const report = new ReportBuilder(set, `선형 ${overview.alignment.name}`);
  const radius = table(set, "min_curve_radius");
  const length = table(set, "min_curve_length");
  const superTable = table(set, "max_superelevation");
  const spiral = table(set, "min_spiral_length");

  if (recorded.length || (given.criteria === undefined && record.criteria))
    report.notes.push(`선형 설명에 기록된 조건을 썼다: ${writeRecord({ ...(given.criteria === undefined ? { criteria: record.criteria } : {}),
      ...Object.fromEntries(recorded.map(name => [name, record[name]])) })}`);
  if (input.designSpeed !== undefined) report.conditions.designSpeed = { value: input.designSpeed, from: "input" };
  else if (speeds.length) report.conditions.designSpeed = describeSpeeds(undefined, speeds)!;
  else report.need("designSpeed", [radius, length, spiral].map(label).join(", "), options(radius, "designSpeed"));
  if (input.area) report.conditions.area = { value: input.area, from: given.area ? "input" : "drawing" };
  checkDesignSpeed(report, set, input, speeds, given.roadClass ? "input" : "drawing");

  // 제19조 needs the maximum superelevation the design applies; without it, the
  // area's maximum from 제21조 is used.
  let emax: { value: number; from: "input" | "drawing" | "criteria" } | undefined;
  if (input.maxSuperelevation !== undefined) emax = { value: input.maxSuperelevation, from: given.maxSuperelevation !== undefined ? "input" : "drawing" };
  else if (input.area) {
    const row = findRow(superTable, { area: input.area });
    if (typeof row?.value === "number") emax = { value: row.value, from: "criteria" };
  }
  if (emax) report.conditions.maxSuperelevation = emax;
  else report.need("maxSuperelevation", label(radius), options(radius, "maxSuperelevation"));
  if (emax?.from === "criteria") report.notes.push(`적용 최대 편경사는 ${superTable.article}의 ${input.area} 최대값 ${emax.value}%를 썼다.`);

  for (const curve of curves) {
    const target = `곡선 ${curve.number} (${curve.startStationText}~${curve.endStationText})`;
    const speed = speedAt(curve.startStation, input.designSpeed, speeds);
    if (!speed) continue;
    const when = { designSpeed: speed.value };
    const context: CurveContext = { handle: key, curve, elements };

    if (curve.minRadius === undefined) report.skip(radius, target, "원곡선 반지름이 없음");
    else if (emax) {
      const row = findRow(radius, { ...when, maxSuperelevation: emax.value });
      if (row) report.compare(radius, target, curve.minRadius, row.value, { fixes: limit => radiusFixes(context, limit) });
      else report.skip(radius, target, `표에 없는 조건 (설계속도 ${speed.value}, 최대 편경사 ${emax.value}%)`);
    }

    const delta = curve.totalDeltaDeg === undefined ? undefined : Math.abs(curve.totalDeltaDeg);
    const lengthRow = delta === undefined ? undefined : findRow(length, { ...when, deltaRange: delta < 5 ? "5도 미만" : "5도 이상" });
    if (!lengthRow) report.skip(length, target, delta === undefined ? "교각을 읽지 못함" : `표에 없는 설계속도 ${speed.value}`);
    else report.compare(length, target, curve.length, lengthRow.value, { deltaDeg: delta, fixes: limit => curveLengthFixes(context, limit) });

    // 제23조①: 60 km/h and above needs spirals; below that, the transition section (제23조③) is not read yet.
    const spirals = elements.filter(element => element.curveGroup === curve.number && element.kind === "Spiral");
    if (speed.value < SPIRAL_REQUIRED_FROM) {
      report.skip(spiral, target, `설계속도 ${speed.value} km/h는 완화구간 대상(제23조③)이며 아직 비교하지 않음`);
    } else if (spirals.length === 0) {
      const row = findRow(spiral, when);
      report.missingElement({ ...spiral, article: "제23조①", title: "완화곡선 설치" }, target,
        `완화곡선 없음. 설계속도 ${SPIRAL_REQUIRED_FROM} km/h 이상은 완화곡선을 설치해야 함`,
        typeof row?.value === "number" ? addSpiralFixes(context, row.value) : []);
    } else {
      const row = findRow(spiral, when);
      for (const element of spirals) {
        const part = `${target} 완화곡선 ${element.startStationText}~${element.endStationText}`;
        if (row) report.compare(spiral, part, element.length, row.value, { fixes: limit => spiralLengthFixes(context, element, limit) });
        else report.skip(spiral, part, `표에 없는 설계속도 ${speed.value}`);
      }
    }
  }

  // 제21조①: the largest lane slope in the superelevation critical stations.
  const slopes = superelevation.flatMap(item => [item.leftOutLanePercent, item.leftInLanePercent, item.rightInLanePercent, item.rightOutLanePercent])
    .filter((value): value is number => typeof value === "number").map(Math.abs);
  if (!input.area) report.need("area", `${label(superTable)}, ${label(radius)}의 최대 편경사`, options(superTable, "area"));
  else if (slopes.length === 0) report.skip(superTable, "선형 전체", overview.settings.superelevationType === "NotSupported"
    ? "편경사를 지원하지 않는 선형" : "편경사가 계산되어 있지 않음");
  else {
    const row = findRow(superTable, { area: input.area });
    if (row) report.compare(superTable, "선형 전체 최대 편경사", Math.max(...slopes), row.value,
      { fixes: limit => superelevationFixes(key, Math.max(...slopes), limit) });
    else report.skip(superTable, "선형 전체", `표에 없는 지역 구분 ${input.area}`);
  }

  if (curves.length === 0) report.notes.push("곡선이 없는 선형이다.");
  return report.build();
}

// 제8조①: each design speed of the alignment against the speed for its road class and
// area, less what the proviso allows; roads in housing estates against the LH ceiling.
function checkDesignSpeed(report: ReportBuilder, set: CriteriaSet, input: AlignmentCriteriaInput,
  speeds: AlignmentDesignSpeed[], from: "input" | "drawing"): void {
  if (!input.roadClass || !input.region) return;
  report.conditions.roadClass = { value: input.roadClass, from };
  report.conditions.region = { value: input.region, from };
  const entries = input.designSpeed !== undefined
    ? [{ stationText: "입력값", speed: input.designSpeed }]
    : speeds.map(item => ({ stationText: `${item.stationText}부터`, speed: item.speed }));
  try {
    const limits = designSpeedLimits(set, input.roadClass, input.region);
    const source = table(set, input.roadClass === APARTMENT_ROAD ? "apartment_road_speed" : "design_speed");
    const note = limits.highest === undefined && limits.lowest < limits.standard
      ? `표 값 ${limits.standard} km/h, 단서로 ${limits.lowest} km/h까지 감속 허용` : undefined;
    if (entries.length === 0) report.skip(source, "선형 설계속도", "선형에 설계속도가 없음");
    for (const entry of entries)
      report.compare(source, `설계속도 ${entry.stationText}`, entry.speed, limits.highest ?? limits.lowest, note ? { note } : {});
  } catch (error) {
    report.notes.push(error instanceof Error ? error.message : String(error));
  }
}
