// 평면선형 설계기준 검토.
// 선형의 곡선·완화곡선·편경사를 기준표(기본: 도로구조규칙 제8·19·20·21·23조)와 비교한다.
// 비교는 모두 이 코드가 하고, AI는 결과를 설명만 한다.

import { callPlugin } from "../bridge/pluginClient.js";
import { readSection } from "../civil/civilData.js";
import type { AlignmentCurve } from "../civil/types/AlignmentCurve.js";
import type { AlignmentDesignSpeed } from "../civil/types/AlignmentDesignSpeed.js";
import type { AlignmentElement } from "../civil/types/AlignmentElement.js";
import type { AlignmentSuperelevation } from "../civil/types/AlignmentSuperelevation.js";
import { loadParameters } from "../knowledge/parameters.js";
import { findRow, loadCriteria, options, table } from "./criteriaStore.js";
import { describeSpeeds, designSpeedLimits, speedAt } from "./designSpeed.js";
import {
  addSpiralFixes, curveLengthFixes, radiusFixes, spiralLengthFixes, superelevationFixes, type CurveContext
} from "./fixes/alignmentFixes.js";
import { label, ReportBuilder } from "./reportBuilder.js";
import { maxSuperelevation } from "./superelevation.js";
import {
  APARTMENT_ROAD, notRoadNote, readRecord, superelevationArea, writeRecord, type Region, type RoadClass
} from "../civil/alignmentRecord.js";
import type { CriteriaSet } from "./types/CriteriaSet.js";
import type { CriteriaReport } from "./types/CriteriaReport.js";

export type AlignmentCriteriaInput = {
  alignment: string;
  criteria?: string;
  designSpeed?: number;
  maxSuperelevation?: number;
  area?: string;
  roadClass?: RoadClass;
  region?: Region;
};

// 이 설계속도(km/h) 이상이면 완화곡선을 설치해야 한다(제23조①).
export const SPIRAL_REQUIRED_FROM = 60;

// 이 검토가 비교하지 않는 평면선형 항목. 결과에 함께 적어 "전부 통과"로 오해하지 않게 한다.
const NOT_COVERED = [
  "곡선부 확폭",
  "시거(정지·앞지르기)",
  "편경사 접속 설치율",
  "설계속도 60 km/h 미만의 완화구간(제23조③)",
  "곡선 사이 직선 길이"
];

// 선형 하나를 기준표와 비교한다.
// 주어지지 않은 조건은 가능한 한 도면에서 가져온다.
//   - 설계속도: 선형의 설계속도 목록
//   - 기준·도로 구분·지역·최대 편경사: 선형을 만들 때 설명(Description)에 기록한 값
//   - 최대 편경사: 그래도 없으면 지역별 기준표 값
export async function checkAlignmentCriteria(given: AlignmentCriteriaInput): Promise<CriteriaReport> {
  await loadParameters();

  // 1) 선형 기본 정보와, 설명에 기록된 조건을 읽는다.
  const overview = await callPlugin("alignment.get", { alignment: given.alignment }) as {
    alignment: { name: string; handle: string; description?: string | null };
    settings: { superelevationType: string };
  };
  const record = readRecord(overview.alignment.description);

  // 질문에서 주지 않았는데 기록에서 채운 조건들(결과 메모에 밝힌다).
  const recorded = (["roadClass", "region", "area", "maxSuperelevation"] as const)
    .filter(name => given[name] === undefined && record[name] !== undefined);

  // 질문 값이 우선, 없으면 기록 값.
  const input: AlignmentCriteriaInput = {
    ...given,
    criteria: given.criteria ?? record.criteria,
    roadClass: given.roadClass ?? record.roadClass,
    region: given.region ?? record.region,
    area: given.area ?? record.area ?? superelevationArea(given.region ?? record.region),
    maxSuperelevation: given.maxSuperelevation ?? record.maxSuperelevation
  };

  const set = await loadCriteria(input.criteria ?? "도로구조규칙");
  const key = overview.alignment.handle;

  // 2) 용도에 도로가 없는 선형(관망 등)은 도로 기준으로 검토하지 않는다.
  const notRoad = notRoadNote(record.uses);
  if (notRoad) {
    const skipped = new ReportBuilder(set, `선형 ${overview.alignment.name}`);
    skipped.notes.push(notRoad);
    return skipped.build();
  }

  // 3) 비교에 필요한 구간 정보를 한꺼번에 읽는다.
  const [curves, elements, speeds, superelevation] = await Promise.all([
    readSection<AlignmentCurve>("alignment.section", { alignment: key }, "curves"),
    readSection<AlignmentElement>("alignment.section", { alignment: key }, "elements"),
    readSection<AlignmentDesignSpeed>("alignment.section", { alignment: key }, "design_speeds"),
    readSection<AlignmentSuperelevation>("alignment.section", { alignment: key }, "superelevation")
  ]);

  const report = new ReportBuilder(set, `선형 ${overview.alignment.name}`, NOT_COVERED);
  const radius = table(set, "min_curve_radius");
  const length = table(set, "min_curve_length");
  const superTable = table(set, "max_superelevation");
  const spiral = table(set, "min_spiral_length");

  // 4) 적용한 조건과 그 출처를 결과에 적는다.
  if (recorded.length || (given.criteria === undefined && record.criteria)) {
    const used = writeRecord({
      ...(given.criteria === undefined ? { criteria: record.criteria } : {}),
      ...Object.fromEntries(recorded.map(name => [name, record[name]]))
    });
    report.notes.push(`선형 설명에 기록된 조건을 썼다: ${used}`);
  }

  if (input.designSpeed !== undefined) report.conditions.designSpeed = { value: input.designSpeed, from: "input" };
  else if (speeds.length) report.conditions.designSpeed = describeSpeeds(undefined, speeds)!;
  else report.need("designSpeed", [radius, length, spiral].map(label).join(", "), options(radius, "designSpeed"));

  if (input.area) report.conditions.area = { value: input.area, from: given.area ? "input" : "drawing" };

  // 5) 제8조: 설계속도가 도로 구분·지역에 맞는지.
  checkDesignSpeed(report, set, input, speeds, given.roadClass ? "input" : "drawing");

  // 6) 제19조는 설계에 적용한 최대 편경사가 필요하다. 없으면 제21조의 지역별 최대값을 쓴다.
  const found = maxSuperelevation(superTable, input.maxSuperelevation, input.area);
  const emax = found && {
    value: found.value,
    from: found.fromTable ? "criteria" as const
      : given.maxSuperelevation !== undefined ? "input" as const
      : "drawing" as const
  };
  if (emax) report.conditions.maxSuperelevation = emax;
  else report.need("maxSuperelevation", label(radius), options(radius, "maxSuperelevation"));
  if (emax?.from === "criteria")
    report.notes.push(`적용 최대 편경사는 ${superTable.article}의 ${input.area} 최대값 ${emax.value}%를 썼다.`);

  // 7) 곡선마다 반지름(제19조), 곡선 길이(제20조), 완화곡선(제23조)을 비교한다.
  for (const curve of curves) {
    const target = `곡선 ${curve.number} (${curve.startStationText}~${curve.endStationText})`;
    const speed = speedAt(curve.startStation, input.designSpeed, speeds);
    if (!speed) continue;
    const when = { designSpeed: speed.value };
    const context: CurveContext = { handle: key, curve, elements };

    // 제19조 최소 평면곡선 반지름
    if (curve.minRadius === undefined) {
      report.skip(radius, target, "원곡선 반지름이 없음");
    } else if (emax) {
      const row = findRow(radius, { ...when, maxSuperelevation: emax.value });
      if (row) report.compare(radius, target, curve.minRadius, row.value, { fixes: limit => radiusFixes(context, limit) });
      else report.skip(radius, target, `표에 없는 조건 (설계속도 ${speed.value}, 최대 편경사 ${emax.value}%)`);
    }

    // 제20조 곡선 최소 길이 (교각 5도 미만/이상으로 표가 나뉜다)
    const delta = curve.totalDeltaDeg === undefined ? undefined : Math.abs(curve.totalDeltaDeg);
    const lengthRow = delta === undefined
      ? undefined
      : findRow(length, { ...when, deltaRange: delta < 5 ? "5도 미만" : "5도 이상" });
    if (!lengthRow) {
      report.skip(length, target, delta === undefined ? "교각을 읽지 못함" : `표에 없는 설계속도 ${speed.value}`);
    } else {
      report.compare(length, target, curve.length, lengthRow.value,
        { deltaDeg: delta, fixes: limit => curveLengthFixes(context, limit) });
    }

    // 제23조① 60 km/h 이상은 완화곡선이 필요하다.
    // 그 아래의 완화구간(제23조③)은 아직 읽지 않는다.
    const spirals = elements.filter(element => element.curveGroup === curve.number && element.kind === "Spiral");
    if (speed.value < SPIRAL_REQUIRED_FROM) {
      report.skip(spiral, target, `설계속도 ${speed.value} km/h는 완화구간 대상(제23조③)이며 아직 비교하지 않음`);
    } else if (spirals.length === 0) {
      const row = findRow(spiral, when);
      report.missingElement(
        { ...spiral, article: "제23조①", title: "완화곡선 설치" },
        target,
        `완화곡선 없음. 설계속도 ${SPIRAL_REQUIRED_FROM} km/h 이상은 완화곡선을 설치해야 함`,
        typeof row?.value === "number" ? addSpiralFixes(context, row.value) : []
      );
    } else {
      const row = findRow(spiral, when);
      for (const element of spirals) {
        const part = `${target} 완화곡선 ${element.startStationText}~${element.endStationText}`;
        if (row) {
          report.compare(spiral, part, element.length, row.value,
            { fixes: limit => spiralLengthFixes(context, element, limit) });
        } else {
          report.skip(spiral, part, `표에 없는 설계속도 ${speed.value}`);
        }
      }
    }
  }

  // 8) 제21조① 편경사 변화 지점들 중 가장 큰 차로 경사를 최대 편경사와 비교한다.
  const slopes = superelevation
    .flatMap(item => [item.leftOutLanePercent, item.leftInLanePercent, item.rightInLanePercent, item.rightOutLanePercent])
    .filter((value): value is number => typeof value === "number")
    .map(Math.abs);

  if (!input.area) {
    report.need("area", `${label(superTable)}, ${label(radius)}의 최대 편경사`, options(superTable, "area"));
  } else if (slopes.length === 0) {
    report.skip(superTable, "선형 전체", overview.settings.superelevationType === "NotSupported"
      ? "편경사를 지원하지 않는 선형"
      : "편경사가 계산되어 있지 않음");
  } else {
    const row = findRow(superTable, { area: input.area });
    if (row) {
      report.compare(superTable, "선형 전체 최대 편경사", Math.max(...slopes), row.value,
        { fixes: limit => superelevationFixes(key, Math.max(...slopes), limit) });
    } else {
      report.skip(superTable, "선형 전체", `표에 없는 지역 구분 ${input.area}`);
    }
  }

  if (curves.length === 0) report.notes.push("곡선이 없는 선형이다.");
  return report.build();
}

// 제8조① 선형의 설계속도(구간별)를 도로 구분·지역의 기준 속도와 비교한다.
// 표 값보다 낮아도 단서가 허용하는 범위 안이면 "review"(사람이 판단).
// 공동주택 단지 내 도로는 LH 지침의 상한과 비교한다.
function checkDesignSpeed(report: ReportBuilder, set: CriteriaSet, input: AlignmentCriteriaInput,
  speeds: AlignmentDesignSpeed[], from: "input" | "drawing"): void {
  if (!input.roadClass || !input.region) return;

  report.conditions.roadClass = { value: input.roadClass, from };
  report.conditions.region = { value: input.region, from };

  // 질문에서 속도를 주면 그 값 하나, 아니면 선형의 구간별 설계속도 전부.
  const entries = input.designSpeed !== undefined
    ? [{ stationText: "입력값", speed: input.designSpeed }]
    : speeds.map(item => ({ stationText: `${item.stationText}부터`, speed: item.speed }));

  try {
    const limits = designSpeedLimits(set, input.roadClass, input.region);
    const source = table(set, input.roadClass === APARTMENT_ROAD ? "apartment_road_speed" : "design_speed");

    // 표 값보다 낮으면 단서로 lowest까지 낮출 수 있다(사유는 사람이 판단).
    const proviso = limits.highest === undefined ? limits.standard - limits.lowest : 0;
    const note = proviso
      ? `표 값보다 낮으면 단서(지형·경제성 등)로 ${limits.lowest} km/h까지 감속 가능. 적용 여부는 사람이 판단`
      : undefined;

    if (entries.length === 0) report.skip(source, "선형 설계속도", "선형에 설계속도가 없음");
    for (const entry of entries) {
      report.compare(source, `설계속도 ${entry.stationText}`, entry.speed, limits.highest ?? limits.standard,
        { proviso, ...(note && entry.speed < limits.standard ? { note } : {}) });
    }
  } catch (error) {
    report.notes.push(error instanceof Error ? error.message : String(error));
  }
}
