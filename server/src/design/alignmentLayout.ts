// 폴리라인으로 선형 배치를 계획한다 (plan_alignment_from_polyline 도구).
//
// 폴리라인의 꼭짓점이 IP가 된다. 도로 선형이면 IP마다 기준이 허용하는 가장 작은 곡선을 넣는다
// (제19조 반지름, 제20조 곡선 길이, 60 km/h 이상은 제23조 완화곡선).
// 단, 사용자가 반지름을 정했거나 폴리라인에 호가 있던 IP는 그 반지름을 쓴다.
//
// 계획에는 IP마다 앞뒤 곡선 사이에 들어가는 반지름 범위와, 양 끝 곡선을 담기에 짧은 직선도 적는다.
// 이 함수는 도면을 바꾸지 않는다. 사용자가 동의하면 apply_drawing_change 가 계획을 적용한다.

import { callPlugin } from "../bridge/pluginClient.js";
import { SPIRAL_REQUIRED_FROM } from "../criteria/alignmentCriteria.js";
import { findRow, loadCriteria, options, table } from "../criteria/criteriaStore.js";
import { loadParameters, step } from "../knowledge/parameters.js";
import { ceilTo, curveLength, curveTangent, floorTo, radians, round, type Curve } from "../geometry.js";
import { criteriaHeader, label } from "../criteria/reportBuilder.js";
import { maxSuperelevation } from "../criteria/superelevation.js";
import type { ConditionValue, CriteriaReport } from "../criteria/types/CriteriaReport.js";
import type { CriteriaSet } from "../criteria/types/CriteriaSet.js";
import type { FixOption } from "../criteria/types/FixOption.js";
import type { FixSource } from "../changes/types/StoredFix.js";
import { deflection, distance, polylinePath } from "./polylinePath.js";
import {
  APARTMENT_ROAD, orderUses, REGIONS, ROAD_CLASSES, superelevationArea, writeRecord,
  type AlignmentUse, type Region, type RoadClass
} from "../civil/alignmentRecord.js";
import { designSpeedLimits } from "../criteria/designSpeed.js";
import type { AlignmentCreateRequest, PlannedIp, PlanPoint, PolylineVertex } from "./types/AlignmentLayout.js";

export type AlignmentLayoutInput = {
  polyline: string;                          // 폴리라인 핸들
  uses: AlignmentUse[];                      // 용도 (도로, 관망, ...)
  name?: string;
  reverse?: boolean;                         // true면 폴리라인 끝점 → 시작점 방향
  designSpeed?: number;
  area?: string;
  maxSuperelevation?: number;
  criteria?: string;
  roadClass?: RoadClass;
  region?: Region;
  radii?: { ip: number; radius: number }[];  // 사용자가 정한 IP별 반지름 (0이면 곡선 없이 꺾임)
};

// 플러그인이 돌려주는 폴리라인 객체.
type PolylineObject = {
  handle: string;
  type: string;
  layer: string;
  geometry?: { closed: boolean; vertexCount: number; vertices: PolylineVertex[]; verticesTruncated: boolean };
};

// 경로로 본 폴리라인: IP들, IP 사이 직선 길이, IP마다의 교각(부호 있음, 좌회전 +).
type Path = {
  object: PolylineObject;
  vertices: PolylineVertex[];
  vertexCount: number;
  points: PlanPoint[];
  straights: number[];
  angles: number[];
};

// 도로 곡선이 지켜야 할 한계값.
type RoadLimits = {
  speed: number;
  minRadius: number;
  spiral: number;                                         // 완화곡선 길이 (0이면 없음)
  minLength: (deltaDeg: number) => number | undefined;    // 교각별 곡선 최소 길이
};

// 도로 설계 조건·한계값·메시지. 선형 검토와 같은 방식으로 정한다.
type RoadDesign = {
  set?: CriteriaSet;
  conditions: Record<string, ConditionValue>;
  missing: CriteriaReport["missing"];
  warnings: string[];
  notes: string[];
  limits?: RoadLimits;
  emax?: number;
};

const NAME_PREFIX = "선형-";        // 이름을 안 주면 "선형-1", "선형-2", ...
const MAX_SEARCH_RADIUS = 100000;   // 들어가는 최대 반지름을 찾을 때의 상한

export async function planAlignmentLayout(input: AlignmentLayoutInput) {
  await loadParameters();

  // 1) 폴리라인을 IP 경로로 읽는다.
  const path = await readPath(input.polyline, input.reverse);
  const uses = orderUses(input.uses);
  if (uses.length === 0) throw new Error("용도를 하나 이상 정해야 한다.");
  const road = uses[0] === "도로";

  // 거의 되돌아가는 IP(교각 179° 초과)에는 곡선을 넣을 수 없다.
  const cusp = path.angles.findIndex(angle => Math.abs(angle) > 179);
  if (cusp >= 0)
    throw new Error(`IP${cusp + 1}에서 폴리라인이 거의 되돌아간다(교각 ${round(Math.abs(path.angles[cusp]), 2)}°).`);

  // 2) 도로면 설계 조건과 한계값을 정하고, IP마다 곡선을 정한다.
  const design: RoadDesign = road
    ? await roadDesign(input)
    : { conditions: {}, missing: [], warnings: [], notes: [] };
  const { ips, curves } = planCurves(path, road, design, input.radii ?? []);

  // 3) 직선마다 양 끝 곡선의 접선장이 들어가는지 확인한다.
  const overlaps = fitCurves(path, ips, curves);

  // 4) 결과. 전체 길이 = 직선 합 + Σ(곡선 길이 − 접선장 2개).
  const { points, straights } = path;
  const length = straights.reduce((sum, value) => sum + value, 0) +
    ips.reduce((sum, planned) => sum + (planned.curveLength ?? 0) - 2 * planned.tangent, 0);

  const result = {
    polyline: { handle: path.object.handle, layer: path.object.layer, vertexCount: path.vertexCount, ipCount: ips.length },
    direction: input.reverse ? "폴리라인 끝점 → 시작점" : "폴리라인 시작점 → 끝점",
    uses,
    alignmentType: road ? "Centerline (도로 중심선)" : "Utility (기타)",
    ...(design.set ? { criteria: criteriaHeader(design.set) } : {}),
    conditions: design.conditions,
    missing: design.missing,
    start: { x: round(points[0].x), y: round(points[0].y) },
    end: { x: round(points.at(-1)!.x), y: round(points.at(-1)!.y) },
    ips,
    overlaps,
    warnings: design.warnings,
    notes: design.notes,
    ...(design.missing.length ? {} : { length: round(length) })
  };

  // 조건이 빠졌으면 아직 만들 수 없다(수정안 없음). 빠진 조건을 물어야 한다.
  if (design.missing.length) return { ...result, option: undefined, source: undefined };
  return { ...result, ...await createOption(input, path, uses, design, ips, curves, overlaps, length) };
}

// 폴리라인을 읽어 IP 경로로 바꾼다. 선형으로 만들 수 없는 폴리라인이면 이유를 들어 오류.
async function readPath(handle: string, reverse?: boolean): Promise<Path> {
  const object = await callPlugin("drawing.object", { handle }) as PolylineObject;
  const geometry = object.geometry;

  if (object.type !== "Polyline" || !geometry)
    throw new Error(`${handle}은(는) ${object.type}이다. 선형은 2D 폴리라인으로만 만들 수 있다.`);
  if (geometry.closed)
    throw new Error("닫힌 폴리라인은 선형으로 만들지 않는다. 열린 폴리라인을 쓰세요.");
  if (geometry.verticesTruncated)
    throw new Error(`꼭짓점이 ${geometry.vertexCount}개라 100개 이하만 처리할 수 있다.`);

  const points = polylinePath(geometry.vertices, reverse);
  if (points.length < 2) throw new Error("폴리라인 길이가 0이다.");

  return {
    object,
    vertices: geometry.vertices,
    vertexCount: geometry.vertexCount,
    points,
    straights: points.slice(1).map((point, index) => distance(points[index], point)),
    angles: points.slice(1, -1).map((point, index) => deflection(points[index], point, points[index + 2]))
  };
}

// 도로 설계 조건과 한계값(최소 반지름, 완화곡선 길이, 곡선 최소 길이)을 정한다.
async function roadDesign(input: AlignmentLayoutInput): Promise<RoadDesign> {
  const set = await loadCriteria(input.criteria ?? "도로구조규칙");
  const design: RoadDesign = { set, conditions: {}, missing: [], warnings: [], notes: [] };
  if (!set.reviewed) design.notes.push("기준표는 원문에서 옮긴 값이며 사람 검토 전이다.");
  design.notes.push(...(set.notes ?? []));

  const [radiusTable, lengthTable, superTable, spiralTable] =
    ["min_curve_radius", "min_curve_length", "max_superelevation", "min_spiral_length"].map(id => table(set, id));

  if (input.roadClass) design.conditions.roadClass = { value: input.roadClass, from: "input" };
  if (input.region) design.conditions.region = { value: input.region, from: "input" };

  // 1) 설계속도 (제8조)
  const speed = designSpeed(set, input, design);

  // 2) 최대 편경사: 주어진 값, 없으면 지역의 제21조 최대값(도시지역은 지역만으로 정해진다).
  const area = input.area ?? superelevationArea(input.region);
  const emax = maxSuperelevation(superTable, input.maxSuperelevation, area);
  if (input.maxSuperelevation !== undefined) {
    design.conditions.maxSuperelevation = { value: input.maxSuperelevation, from: "input" };
  } else if (area) {
    design.conditions.area = { value: area, from: input.area ? "input" : "criteria" };
    if (emax) {
      design.conditions.maxSuperelevation = { value: emax.value, from: "criteria" };
      design.notes.push(`적용 최대 편경사는 ${label(superTable)}의 ${area} 최대값 ${emax.value}%를 썼다.`);
    }
  }
  design.emax = emax?.value;

  // 편경사를 정할 수 없으면 지역을 물어야 한다(지방지역이면 지방지역 선택지만).
  if (!emax) {
    design.missing.push({
      name: "area",
      neededFor: `${label(radiusTable)}의 최대 편경사`,
      options: options(superTable, "area")
        .filter(item => !input.region?.startsWith("지방지역") || String(item).startsWith("지방지역"))
    });
  }
  if (speed === undefined || !emax) return design;

  // 3) 한계값.
  const radiusRow = findRow(radiusTable, { designSpeed: speed, maxSuperelevation: emax.value });
  if (typeof radiusRow?.value !== "number")
    throw new Error(`${label(radiusTable)} 표에 설계속도 ${speed} km/h, 최대 편경사 ${emax.value}% 행이 없다.`);
  const spiralRow = findRow(spiralTable, { designSpeed: speed });

  design.limits = {
    speed,
    minRadius: radiusRow.value,
    // 60 km/h 이상만 완화곡선. 길이는 승인된 올림 단위가 있으면 그 단위로 올린다.
    spiral: speed >= SPIRAL_REQUIRED_FROM && typeof spiralRow?.value === "number"
      ? ceilTo(spiralRow.value, step("alignment.spiralStep", 1, design.notes))
      : 0,
    // 곡선 최소 길이: 교각 5도 미만이면 "상수 ÷ 교각" 형태.
    minLength: deltaDeg => {
      const row = findRow(lengthTable, { designSpeed: speed, deltaRange: deltaDeg < 5 ? "5도 미만" : "5도 이상" });
      if (row === undefined) return undefined;
      return typeof row.value === "number" ? row.value : row.value.divideByDeltaDeg / deltaDeg;
    }
  };

  if (speed < SPIRAL_REQUIRED_FROM) {
    design.notes.push(`설계속도 ${speed} km/h는 완화곡선 설치 대상(${label(spiralTable)}, ` +
      `${SPIRAL_REQUIRED_FROM} km/h 이상)이 아니라 원곡선만 넣었다.`);
  }
  return design;
}

// 설계속도: 주어진 값이면 제8조 범위에 맞는지 확인하고, 없으면 제8조 표 값을 쓴다.
// 도로 구분·지역도 없으면 물어야 할 조건으로 남긴다.
function designSpeed(set: CriteriaSet, input: AlignmentLayoutInput, design: RoadDesign): number | undefined {
  const limits = input.roadClass && input.region ? designSpeedLimits(set, input.roadClass, input.region) : undefined;
  const speed = input.designSpeed;

  // 1) 사용자가 정한 속도
  if (speed !== undefined) {
    design.conditions.designSpeed = { value: speed, from: "input" };
    if (limits?.highest !== undefined && speed > limits.highest) {
      design.warnings.push(`설계속도 ${speed} km/h는 ${limits.label} 상한 ${limits.highest} km/h를 넘음`);
    } else if (limits && speed < limits.lowest) {
      design.warnings.push(`설계속도 ${speed} km/h는 ${limits.label} 표 값 ${limits.standard} km/h에서 ` +
        `단서의 감속을 뺀 ${limits.lowest} km/h보다 낮음`);
    } else if (limits && speed < limits.standard) {
      design.notes.push(`설계속도 ${speed} km/h는 ${limits.label} 표 값 ${limits.standard} km/h보다 낮아 ` +
        "단서(지형·경제성 등으로 필요한 경우 20 km/h 이내 감속)를 적용한 것이다. 감속 사유를 설계에 남겨야 한다.");
    }
    return speed;
  }

  // 2) 도로 구분·지역으로 정해지는 속도
  if (limits) {
    design.conditions.designSpeed = { value: limits.standard, from: "criteria" };
    design.notes.push(limits.highest !== undefined
      ? `설계속도는 ${limits.label} 상한 ${limits.standard} km/h를 썼다.`
      : `설계속도는 ${limits.label} 표 값 ${limits.standard} km/h를 썼다. ` +
        `지형·경제성 등으로 필요하면 ${limits.lowest} km/h까지 낮출 수 있다(단서).`);
    return limits.standard;
  }

  // 3) 정할 수 없음: 빠진 조건(도로 구분, 지역)을 선택지와 함께 남긴다.
  const speedTable = table(set, "design_speed");
  const classes = ROAD_CLASSES.filter(item =>
    item !== APARTMENT_ROAD || set.tables.some(other => other.id === "apartment_road_speed"));
  if (!input.roadClass) design.missing.push({ name: "roadClass", neededFor: label(speedTable), options: [...classes] });
  if (!input.region) design.missing.push({ name: "region", neededFor: label(speedTable), options: [...REGIONS] });
  return undefined;
}

// IP마다 넣을 곡선과 그 반지름의 근거.
function planCurves(path: Path, road: boolean, design: RoadDesign, radii: { ip: number; radius: number }[]) {
  const { points, straights, angles } = path;
  const { limits, warnings } = design;
  const asked = new Map(radii.map(item => [item.ip, item.radius]));
  const ips: PlannedIp[] = [];
  const curves: (Curve | undefined)[] = [];

  angles.forEach((angle, index) => {
    const ip = index + 1;
    const deltaDeg = Math.abs(angle);
    const deltaRad = radians(deltaDeg);

    // 원하는 반지름: 사용자 지정 > 폴리라인 호
    const wanted = asked.get(ip) ?? points[ip].radius;
    const wantedFrom = asked.has(ip) ? "사용자 지정" : "폴리라인 호";

    const planned: PlannedIp = {
      ip,
      x: round(points[ip].x),
      y: round(points[ip].y),
      deflectionDeg: round(deltaDeg, 4),
      turn: angle > 0 ? "좌" : "우",
      straightBefore: round(straights[index]),
      straightAfter: round(straights[index + 1]),
      tangent: 0,
      status: "ok"
    };
    let curve: Curve | undefined;

    if (road && !limits) {
      // 도로인데 조건이 아직 없음
      planned.note = "설계 조건이 정해지면 반지름을 정함";
    } else if (limits) {
      // 도로: 필요한 최소 반지름 = 아래 세 조건 중 가장 큰 값
      //   ① 제19조 최소 반지름
      //   ② 제20조 곡선 최소 길이를 채우는 반지름 ((L − Ls) ÷ 교각)
      //   ③ 완화곡선 두 개가 교각 안에 들어가는 반지름
      const minLength = limits.minLength(deltaDeg);
      const needs: [number, string][] = [[limits.minRadius, "제19조 최소 평면곡선 반지름"]];
      if (minLength !== undefined)
        needs.push([(minLength - limits.spiral) / deltaRad, `제20조 곡선 최소 길이 ${round(minLength)} m`]);
      if (limits.spiral)
        needs.push([limits.spiral / deltaRad * 1.001, "완화곡선 두 개가 들어갈 교각"]);

      const [governing, why] = needs.reduce((a, b) => (b[0] > a[0] ? b : a));
      // 계획 반지름은 5 m 단위(승인된 설정값이 있으면 그 단위)로 올린다.
      const required = ceilTo(governing, step("alignment.radiusStep", 5, design.notes));
      planned.minRadius = required;

      if (wanted === 0) {
        // 사용자가 곡선 없이 꺾이게 해 달라고 함
        planned.status = "angle_point";
        warnings.push(`IP${ip}: 곡선 없이 꺾이게 해 달라는 요청. 도로 중심선에는 곡선이 필요함`);
      } else if (wanted !== undefined) {
        // 원하는 반지름을 쓰되, 기준 미달이면 경고
        curve = { radius: round(wanted), spiral: limits.spiral };
        planned.radiusFrom = wantedFrom;
        if (wanted < governing - 1e-6) {
          planned.status = "below_criteria";
          planned.note = `${why} 기준으로 R ${required} 이상 필요`;
          warnings.push(`IP${ip}: R ${round(wanted)}은 ${why} 기준 최소 ${required} m 미달 (${wantedFrom})`);
        }
      } else {
        // 기준이 허용하는 가장 작은 곡선
        curve = { radius: required, spiral: limits.spiral };
        planned.radiusFrom = why;
      }
    } else if (wanted) {
      // 도로가 아님: 원하는 반지름이 있는 IP에만 원곡선
      curve = { radius: round(wanted), spiral: 0 };
      planned.radiusFrom = wantedFrom;
    } else {
      planned.status = "angle_point";
    }

    // 곡선이 정해졌으면 접선장·곡선 길이·완화곡선 정보를 채운다.
    if (curve) {
      planned.radius = curve.radius;
      planned.tangent = round(curveTangent(curve, deltaRad));
      planned.curveLength = round(curveLength(curve, deltaRad));
      if (curve.spiral)
        Object.assign(planned, { spiralLength: curve.spiral, spiralA: round(Math.sqrt(curve.radius * curve.spiral), 1) });
    }
    ips.push(planned);
    curves.push(curve);
  });

  return { ips, curves };
}

// 직선마다 양 끝 곡선의 접선장 합을 담을 수 있어야 한다.
// 못 담는 곡선은 overlap 으로 표시하고, IP마다 들어가는 최대 반지름을 구하고, 짧은 직선 목록을 돌려준다.
function fitCurves({ points, straights }: Path, ips: PlannedIp[], curves: (Curve | undefined)[]): string[] {
  // 점 번호(0 = 시점)의 접선장. 시점·종점은 0.
  const tangent = (point: number) => ips[point - 1]?.tangent ?? 0;
  const overlaps: string[] = [];

  // 1) 짧은 직선 찾기
  straights.forEach((length, index) => {
    const need = tangent(index) + tangent(index + 1);
    if (need <= length + 1e-6) return;

    const ends = [index, index + 1].filter(point => point >= 1 && point <= ips.length && curves[point - 1]);
    ends.forEach(point => { ips[point - 1].status = "overlap"; });

    const from = index === 0 ? "시점" : `IP${index}`;
    const to = index + 1 === points.length - 1 ? "종점" : `IP${index + 1}`;
    overlaps.push(`${from}~${to} 직선 ${round(length)} m < 접선장 합 ${round(need)} m`);
  });

  // 2) IP마다, 앞뒤 곡선을 그대로 둘 때 들어가는 최대 반지름
  ips.forEach((planned, index) => {
    const curve = curves[index];
    if (!curve) return;

    const room = Math.min(straights[index] - tangent(index), straights[index + 1] - tangent(index + 2));
    const smallest = curve.spiral ? curve.spiral / radians(planned.deflectionDeg) * 1.001 : 0.001;
    const largest = largestFitting(curve.spiral, radians(planned.deflectionDeg), room, smallest);

    if (largest === undefined) {
      planned.note = [planned.note, "앞뒤 직선이 짧아 이 IP에는 기준에 맞는 곡선이 들어가지 않음 (가능 범위 없음)"]
        .filter(Boolean).join("; ");
    } else if (largest < MAX_SEARCH_RADIUS) {
      planned.maxRadius = floorTo(largest);
    }
  });

  return overlaps;
}

// 접선장이 여유(room) 안에 들어가는 가장 큰 반지름(이분 탐색).
// 가장 작은 반지름도 안 들어가면 undefined.
function largestFitting(spiral: number, deltaRad: number, room: number, smallest: number): number | undefined {
  const fits = (radius: number) => curveTangent({ radius, spiral }, deltaRad) <= room;
  if (!fits(smallest)) return undefined;
  if (fits(MAX_SEARCH_RADIUS)) return MAX_SEARCH_RADIUS;

  let [low, high] = [smallest, MAX_SEARCH_RADIUS];
  for (let step = 0; step < 60; step++) {
    const middle = (low + high) / 2;
    if (fits(middle)) low = middle;
    else high = middle;
  }
  return low;
}

// 사용자가 동의할 수 있는 "선형 생성" 수정안과, 만든 뒤 다시 돌릴 검토.
async function createOption(input: AlignmentLayoutInput, path: Path, uses: AlignmentUse[], design: RoadDesign,
  ips: PlannedIp[], curves: (Curve | undefined)[], overlaps: string[], length: number):
  Promise<{ option: FixOption; source: FixSource }> {
  const road = design.set !== undefined;
  const { limits, emax } = design;

  // 1) 이름: 주어진 이름(이미 있으면 conflict), 없으면 비어 있는 "선형-N".
  const names = await alignmentNames();
  let name = input.name?.trim();
  const nameTaken = name !== undefined && names.has(name);
  if (!name) for (let number = 1; ; number++) if (!names.has(name = `${NAME_PREFIX}${number}`)) break;

  // 2) 플러그인에 보낼 생성 요청. 설계 조건은 선형 설명에 기록해, 나중 검토가 다시 묻지 않게 한다.
  const create: AlignmentCreateRequest = {
    name: name!,
    type: road ? "Centerline" : "Utility",
    polyline: { handle: path.object.handle, vertices: path.vertices },
    points: path.points.map(({ x, y }) => ({ x, y })),
    curves: curves.map(curve => curve ? { radius: curve.radius, ...(curve.spiral ? { spiralLength: curve.spiral } : {}) } : {}),
    ...(limits ? { designSpeed: limits.speed } : {}),
    description: writeRecord({
      uses,
      criteria: design.set?.id,
      ...(road ? {
        roadClass: input.roadClass,
        region: input.region,
        area: input.maxSuperelevation === undefined ? input.area ?? superelevationArea(input.region) : input.area,
        maxSuperelevation: emax
      } : {})
    })
  };

  // 3) 수정안. 짧은 직선이 있거나 이름이 겹치면 conflict.
  const curveCount = curves.filter(Boolean).length;
  const option: FixOption = {
    title: `선형 ${name} 생성`,
    changes: [],
    create,
    status: overlaps.length || nameTaken ? "conflict" : "feasible",
    ...(nameTaken
      ? { reason: `같은 이름의 선형 ${name}이(가) 이미 있음` }
      : overlaps.length ? { reason: overlaps.join("; ") } : {}),
    effects: [
      `${uses.join("·")} 선형, IP ${ips.length}개, 곡선 ${curveCount}개` +
        (limits?.spiral ? ` (양쪽 완화곡선 ${limits.spiral} m)` : ""),
      `길이 약 ${round(length)} m (계산값)`,
      `선형 설명에 "${create.description}" 기록`,
      ...(limits ? [`선형 설계속도 ${limits.speed} km/h 기록`] : []),
      "사이트 없음, 도면 기본 스타일·레이어, 폴리라인은 그대로 둠"
    ]
  };

  // 4) 만든 뒤 돌릴 검토(도로면 평면선형 검토, 아니면 없음).
  const source: FixSource = road
    ? {
      check: "alignment",
      input: {
        alignment: name!,
        criteria: design.set?.id,
        designSpeed: limits?.speed,
        roadClass: input.roadClass,
        region: input.region,
        ...(input.maxSuperelevation !== undefined ? { maxSuperelevation: input.maxSuperelevation } : {}),
        ...(input.area ? { area: input.area } : {})
      }
    }
    : { check: "none" };

  return { option, source };
}

// 도면에 있는 선형 이름 전체(이름 겹침 확인용).
async function alignmentNames(): Promise<Set<string>> {
  const names = new Set<string>();
  for (let offset = 0; ; offset += 200) {
    const page = await callPlugin("alignment.list", { offset, limit: 200 }) as { totalCount: number; items: { name: string }[] };
    page.items.forEach(item => names.add(item.name));
    if (names.size >= page.totalCount || page.items.length === 0) return names;
  }
}
