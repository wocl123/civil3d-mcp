import { callPlugin } from "../bridge/pluginClient.js";
import { SPIRAL_REQUIRED_FROM } from "../criteria/alignmentCriteria.js";
import { findRow, loadCriteria, options, table, verificationText } from "../criteria/criteriaStore.js";
import { ceilTo, floorTo, radians, round } from "../criteria/fixes/geometry.js";
import { label } from "../criteria/reportBuilder.js";
import type { ConditionValue, CriteriaReport } from "../criteria/types/CriteriaReport.js";
import type { FixOption } from "../criteria/types/FixOption.js";
import type { FixSource } from "../changes/types/StoredFix.js";
import { deflection, distance, polylinePath } from "./polylinePath.js";
import { APARTMENT_ROAD, orderUses, REGIONS, ROAD_CLASSES, superelevationArea, writeRecord,
  type AlignmentUse, type Region, type RoadClass } from "./alignmentRecord.js";
import { designSpeedLimits } from "../criteria/designSpeed.js";
import type { AlignmentCreateRequest, PlannedIp, PolylineVertex } from "./types/AlignmentLayout.js";

export type AlignmentLayoutInput = {
  polyline: string; uses: AlignmentUse[]; name?: string; reverse?: boolean;
  designSpeed?: number; area?: string; maxSuperelevation?: number; criteria?: string;
  roadClass?: RoadClass; region?: Region;
  radii?: { ip: number; radius: number }[];
};

type PolylineObject = {
  handle: string; type: string; layer: string;
  geometry?: { closed: boolean; vertexCount: number; vertices: PolylineVertex[]; verticesTruncated: boolean };
};

// A curve at one IP: a circular arc, with clothoids of length spiral on both sides when spiral > 0.
type Curve = { radius: number; spiral: number };

const NAME_PREFIX = "선형-";
const MAX_SEARCH_RADIUS = 100000;

// Tangent length from the IP to the start of the curve. With clothoids the arc shifts
// inward by p and the tangent grows by k (standard series to the second term).
function tangentLength({ radius, spiral }: Curve, deltaRad: number): number {
  if (!spiral) return radius * Math.tan(deltaRad / 2);
  const shift = spiral ** 2 / (24 * radius) - spiral ** 4 / (2688 * radius ** 3);
  const k = spiral / 2 - spiral ** 3 / (240 * radius ** 2);
  return (radius + shift) * Math.tan(deltaRad / 2) + k;
}

// Arc plus both spirals: RΔ − Ls + 2Ls.
const curveLength = ({ radius, spiral }: Curve, deltaRad: number) => radius * deltaRad + spiral;

// The largest radius whose tangent still fits in the room, or undefined when even the smallest does not.
function largestFitting(spiral: number, deltaRad: number, room: number, smallest: number): number | undefined {
  const fits = (radius: number) => tangentLength({ radius, spiral }, deltaRad) <= room;
  if (!fits(smallest)) return undefined;
  if (fits(MAX_SEARCH_RADIUS)) return MAX_SEARCH_RADIUS;
  let [low, high] = [smallest, MAX_SEARCH_RADIUS];
  for (let step = 0; step < 60; step++) {
    const middle = (low + high) / 2;
    if (fits(middle)) low = middle; else high = middle;
  }
  return low;
}

async function alignmentNames(): Promise<Set<string>> {
  const names = new Set<string>();
  for (let offset = 0; ; offset += 200) {
    const page = await callPlugin("alignment.list", { offset, limit: 200 }) as { totalCount: number; items: { name: string }[] };
    page.items.forEach(item => names.add(item.name));
    if (names.size >= page.totalCount || page.items.length === 0) return names;
  }
}

// Plans an alignment along a polyline. The polyline's vertices are the IPs; for a road
// each IP gets the smallest curve the criteria allow (제19조 radius, 제20조 length, and
// 제23조 spirals from 60 km/h), unless a radius is asked for or the polyline had an arc
// there. The plan reports, for each IP, the radius range that fits between its
// neighbours, and any straight too short for the curves on both ends. Nothing is drawn:
// the plan's option is applied only after the user agrees (apply_drawing_change).
export async function planAlignmentLayout(input: AlignmentLayoutInput) {
  const object = await callPlugin("drawing.object", { handle: input.polyline }) as PolylineObject;
  const geometry = object.geometry;
  if (object.type !== "Polyline" || !geometry)
    throw new Error(`${input.polyline}은(는) ${object.type}이다. 선형은 2D 폴리라인으로만 만들 수 있다.`);
  if (geometry.closed) throw new Error("닫힌 폴리라인은 선형으로 만들지 않는다. 열린 폴리라인을 쓰세요.");
  if (geometry.verticesTruncated) throw new Error(`꼭짓점이 ${geometry.vertexCount}개라 100개 이하만 처리할 수 있다.`);
  const points = polylinePath(geometry.vertices, input.reverse);
  if (points.length < 2) throw new Error("폴리라인 길이가 0이다.");

  const uses = orderUses(input.uses);
  if (uses.length === 0) throw new Error("용도를 하나 이상 정해야 한다.");
  const road = uses[0] === "도로";
  const straights = points.slice(1).map((point, index) => distance(points[index], point));
  const angles = points.slice(1, -1).map((point, index) => deflection(points[index], point, points[index + 2]));
  const cusp = angles.findIndex(angle => Math.abs(angle) > 179);
  if (cusp >= 0) throw new Error(`IP${cusp + 1}에서 폴리라인이 거의 되돌아간다(교각 ${round(Math.abs(angles[cusp]), 2)}°).`);

  // Conditions and limits for a road, as the alignment check uses them.
  const conditions: Record<string, ConditionValue> = {};
  const missing: CriteriaReport["missing"] = [];
  const warnings: string[] = [];
  const notes: string[] = [];
  let criteria: CriteriaReport["criteria"] | undefined;
  let limits: { speed: number; minRadius: number; spiral: number; minLength: (deltaDeg: number) => number | undefined } | undefined;
  let emax: number | undefined;
  let criteriaId: string | undefined;
  if (road) {
    const set = await loadCriteria(input.criteria ?? "도로구조규칙");
    criteriaId = set.id;
    criteria = { id: set.id, title: set.title, effective: set.source.effective?.replace(/^(\d{4})(\d{2})(\d{2})$/, "$1-$2-$3"),
      reviewed: set.reviewed, verification: verificationText(set) };
    if (!set.reviewed) notes.push("기준표는 원문에서 옮긴 값이며 사람 검토 전이다.");
    notes.push(...(set.notes ?? []));
    const [radiusTable, lengthTable, superTable, spiralTable] =
      ["min_curve_radius", "min_curve_length", "max_superelevation", "min_spiral_length"].map(id => table(set, id));

    // Design speed: as given, checked against 제8조 for the road class and area, or else taken from 제8조.
    if (input.roadClass) conditions.roadClass = { value: input.roadClass, from: "input" };
    if (input.region) conditions.region = { value: input.region, from: "input" };
    const speedLimits = input.roadClass && input.region ? designSpeedLimits(set, input.roadClass, input.region) : undefined;
    let speed = input.designSpeed;
    if (speed !== undefined) {
      conditions.designSpeed = { value: speed, from: "input" };
      if (speedLimits?.highest !== undefined && speed > speedLimits.highest)
        warnings.push(`설계속도 ${speed} km/h는 ${speedLimits.label} 상한 ${speedLimits.highest} km/h를 넘음`);
      else if (speedLimits && speed < speedLimits.lowest)
        warnings.push(`설계속도 ${speed} km/h는 ${speedLimits.label} 표 값 ${speedLimits.standard} km/h에서 단서의 감속을 뺀 ${speedLimits.lowest} km/h보다 낮음`);
      else if (speedLimits && speed < speedLimits.standard)
        notes.push(`설계속도 ${speed} km/h는 ${speedLimits.label} 표 값 ${speedLimits.standard} km/h보다 낮아 단서(지형·경제성 등으로 필요한 경우 20 km/h 이내 감속)를 적용한 것이다. 감속 사유를 설계에 남겨야 한다.`);
    } else if (speedLimits) {
      speed = speedLimits.standard;
      conditions.designSpeed = { value: speed, from: "criteria" };
      notes.push(speedLimits.highest !== undefined
        ? `설계속도는 ${speedLimits.label} 상한 ${speed} km/h를 썼다.`
        : `설계속도는 ${speedLimits.label} 표 값 ${speed} km/h를 썼다. 지형·경제성 등으로 필요하면 ${speedLimits.lowest} km/h까지 낮출 수 있다(단서).`);
    } else {
      const speedTable = table(set, "design_speed");
      const classes = ROAD_CLASSES.filter(item => item !== APARTMENT_ROAD || set.tables.some(other => other.id === "apartment_road_speed"));
      if (!input.roadClass) missing.push({ name: "roadClass", neededFor: label(speedTable), options: [...classes] });
      if (!input.region) missing.push({ name: "region", neededFor: label(speedTable), options: [...REGIONS] });
    }

    // Maximum superelevation: as given, else the 제21조 maximum for the area (urban areas settle it).
    const area = input.area ?? superelevationArea(input.region);
    if (input.maxSuperelevation !== undefined) {
      emax = input.maxSuperelevation;
      conditions.maxSuperelevation = { value: emax, from: "input" };
    } else if (area) {
      conditions.area = { value: area, from: input.area ? "input" : "criteria" };
      const row = findRow(superTable, { area });
      if (typeof row?.value === "number") {
        emax = row.value;
        conditions.maxSuperelevation = { value: emax, from: "criteria" };
        notes.push(`적용 최대 편경사는 ${label(superTable)}의 ${area} 최대값 ${emax}%를 썼다.`);
      }
    }
    if (emax === undefined) missing.push({ name: "area", neededFor: `${label(radiusTable)}의 최대 편경사`,
      options: options(superTable, "area").filter(item => !input.region?.startsWith("지방지역") || String(item).startsWith("지방지역")) });

    if (speed !== undefined && emax !== undefined) {
      const radiusRow = findRow(radiusTable, { designSpeed: speed, maxSuperelevation: emax });
      if (typeof radiusRow?.value !== "number")
        throw new Error(`${label(radiusTable)} 표에 설계속도 ${speed} km/h, 최대 편경사 ${emax}% 행이 없다.`);
      const spiralRow = findRow(spiralTable, { designSpeed: speed });
      const spiral = speed >= SPIRAL_REQUIRED_FROM && typeof spiralRow?.value === "number" ? ceilTo(spiralRow.value) : 0;
      limits = {
        speed, minRadius: radiusRow.value, spiral,
        minLength: deltaDeg => {
          const row = findRow(lengthTable, { designSpeed: speed, deltaRange: deltaDeg < 5 ? "5도 미만" : "5도 이상" });
          if (row === undefined) return undefined;
          return typeof row.value === "number" ? row.value : row.value.divideByDeltaDeg / deltaDeg;
        }
      };
      if (speed < SPIRAL_REQUIRED_FROM) notes.push(`설계속도 ${speed} km/h는 완화곡선 설치 대상(${label(spiralTable)}, ${SPIRAL_REQUIRED_FROM} km/h 이상)이 아니라 원곡선만 넣었다.`);
    }
  }

  // The curve at each IP and why that radius.
  const asked = new Map((input.radii ?? []).map(item => [item.ip, item.radius]));
  const ips: PlannedIp[] = [];
  const curves: (Curve | undefined)[] = [];
  angles.forEach((angle, index) => {
    const ip = index + 1;
    const deltaDeg = Math.abs(angle);
    const deltaRad = radians(deltaDeg);
    const fromPolyline = points[ip].radius;
    const wanted = asked.get(ip) ?? fromPolyline;
    const wantedFrom = asked.has(ip) ? "사용자 지정" : "폴리라인 호";
    const planned: PlannedIp = {
      ip, x: round(points[ip].x), y: round(points[ip].y), deflectionDeg: round(deltaDeg, 4), turn: angle > 0 ? "좌" : "우",
      straightBefore: round(straights[index]), straightAfter: round(straights[index + 1]), tangent: 0, status: "ok"
    };
    let curve: Curve | undefined;
    if (road && !limits) planned.note = "설계 조건이 정해지면 반지름을 정함";
    else if (limits) {
      const minLength = limits.minLength(deltaDeg);
      const needs: [number, string][] = [[limits.minRadius, "제19조 최소 평면곡선 반지름"]];
      if (minLength !== undefined) needs.push([(minLength - limits.spiral) / deltaRad, `제20조 곡선 최소 길이 ${round(minLength)} m`]);
      if (limits.spiral) needs.push([limits.spiral / deltaRad * 1.001, "완화곡선 두 개가 들어갈 교각"]);
      const [governing, why] = needs.reduce((a, b) => (b[0] > a[0] ? b : a));
      const required = ceilTo(governing, 5);
      planned.minRadius = required;
      if (wanted === 0) {
        planned.status = "angle_point";
        warnings.push(`IP${ip}: 곡선 없이 꺾이게 해 달라는 요청. 도로 중심선에는 곡선이 필요함`);
      } else if (wanted !== undefined) {
        curve = { radius: round(wanted), spiral: limits.spiral };
        planned.radiusFrom = wantedFrom;
        if (wanted < governing - 1e-6) {
          planned.status = "below_criteria";
          planned.note = `${why} 기준으로 R ${required} 이상 필요`;
          warnings.push(`IP${ip}: R ${round(wanted)}은 ${why} 기준 최소 ${required} m 미달 (${wantedFrom})`);
        }
      } else {
        curve = { radius: required, spiral: limits.spiral };
        planned.radiusFrom = why;
      }
    } else if (wanted) {
      curve = { radius: round(wanted), spiral: 0 };
      planned.radiusFrom = wantedFrom;
    } else planned.status = "angle_point";

    if (curve) {
      planned.radius = curve.radius;
      planned.tangent = round(tangentLength(curve, deltaRad));
      planned.curveLength = round(curveLength(curve, deltaRad));
      if (curve.spiral) Object.assign(planned, { spiralLength: curve.spiral, spiralA: round(Math.sqrt(curve.radius * curve.spiral), 1) });
    }
    ips.push(planned);
    curves.push(curve);
  });

  // Each straight must hold the tangents of the curves at both of its ends.
  const tangent = (point: number) => ips[point - 1]?.tangent ?? 0;
  const overlaps: string[] = [];
  straights.forEach((length, index) => {
    const need = tangent(index) + tangent(index + 1);
    if (need <= length + 1e-6) return;
    const ends = [index, index + 1].filter(point => point >= 1 && point <= ips.length && curves[point - 1]);
    ends.forEach(point => { ips[point - 1].status = "overlap"; });
    overlaps.push(`${index === 0 ? "시점" : `IP${index}`}~${index + 1 === points.length - 1 ? "종점" : `IP${index + 1}`} 직선 ${round(length)} m < 접선장 합 ${round(need)} m`);
  });
  ips.forEach((planned, index) => {
    const curve = curves[index];
    if (!curve) return;
    const room = Math.min(straights[index] - tangent(index), straights[index + 1] - tangent(index + 2));
    const smallest = curve.spiral ? curve.spiral / radians(planned.deflectionDeg) * 1.001 : 0.001;
    const largest = largestFitting(curve.spiral, radians(planned.deflectionDeg), room, smallest);
    if (largest === undefined)
      planned.note = [planned.note, "앞뒤 직선이 짧아 이 IP에는 기준에 맞는 곡선이 들어가지 않음 (가능 범위 없음)"].filter(Boolean).join("; ");
    else if (largest < MAX_SEARCH_RADIUS) planned.maxRadius = floorTo(largest);
  });

  const length = straights.reduce((sum, value) => sum + value, 0) +
    ips.reduce((sum, planned) => sum + (planned.curveLength ?? 0) - 2 * planned.tangent, 0);
  const result = {
    polyline: { handle: object.handle, layer: object.layer, vertexCount: geometry.vertexCount, ipCount: ips.length },
    direction: input.reverse ? "폴리라인 끝점 → 시작점" : "폴리라인 시작점 → 끝점",
    uses, alignmentType: road ? "Centerline (도로 중심선)" : "Utility (기타)",
    ...(criteria ? { criteria } : {}),
    conditions, missing,
    start: { x: round(points[0].x), y: round(points[0].y) }, end: { x: round(points.at(-1)!.x), y: round(points.at(-1)!.y) },
    ips, overlaps, warnings, notes,
    ...(missing.length ? {} : { length: round(length) })
  };
  if (missing.length) return { ...result, option: undefined, source: undefined };

  const names = await alignmentNames();
  let name = input.name?.trim();
  const nameTaken = name !== undefined && names.has(name);
  if (!name) for (let number = 1; ; number++) if (!names.has(name = `${NAME_PREFIX}${number}`)) break;
  const create: AlignmentCreateRequest = {
    name: name!, type: road ? "Centerline" : "Utility",
    polyline: { handle: object.handle, vertices: geometry.vertices },
    points: points.map(({ x, y }) => ({ x, y })),
    curves: curves.map(curve => curve ? { radius: curve.radius, ...(curve.spiral ? { spiralLength: curve.spiral } : {}) } : {}),
    ...(limits ? { designSpeed: limits.speed } : {}),
    description: writeRecord({ uses, criteria: criteriaId, ...(road ? { roadClass: input.roadClass, region: input.region,
      area: input.maxSuperelevation === undefined ? input.area ?? superelevationArea(input.region) : input.area, maxSuperelevation: emax } : {}) })
  };
  const curveCount = curves.filter(Boolean).length;
  const option: FixOption = {
    title: `선형 ${name} 생성`,
    changes: [],
    create,
    status: overlaps.length || nameTaken ? "conflict" : "feasible",
    ...(nameTaken ? { reason: `같은 이름의 선형 ${name}이(가) 이미 있음` } : overlaps.length ? { reason: overlaps.join("; ") } : {}),
    effects: [
      `${uses.join("·")} 선형, IP ${ips.length}개, 곡선 ${curveCount}개${limits?.spiral ? ` (양쪽 완화곡선 ${limits.spiral} m)` : ""}`,
      `길이 약 ${round(length)} m (계산값)`,
      `선형 설명에 "${create.description}" 기록`,
      ...(limits ? [`선형 설계속도 ${limits.speed} km/h 기록`] : []),
      "사이트 없음, 도면 기본 스타일·레이어, 폴리라인은 그대로 둠"
    ]
  };
  const source: FixSource = road
    ? { check: "alignment", input: { alignment: name!, criteria: criteriaId, designSpeed: limits?.speed, roadClass: input.roadClass, region: input.region,
        ...(input.maxSuperelevation !== undefined ? { maxSuperelevation: input.maxSuperelevation } : {}), ...(input.area ? { area: input.area } : {}) } }
    : { check: "none" };
  return { ...result, option, source };
}
