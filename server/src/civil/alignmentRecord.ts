// What an alignment is for and the conditions it was designed to, recorded in its
// Description when it is created, for example
//   "용도: 도로, 관망 / 기준: LH_설계지침_토목 / 도로 구분: 집산도로 / 지역: 도시지역 / 편경사 지역: 도시지역 / 최대편경사: 6%".
// Civil 3D's own types cannot tell a pipe alignment from a channel, and the checks need
// the criteria, road class, and area the design used; recording them in the drawing
// means nobody is asked again. One alignment can serve several uses, such as a road
// centerline the pipe network also follows.
export const ALIGNMENT_USES = ["도로", "관망", "수로/하천", "구조물", "기타"] as const;
export type AlignmentUse = typeof ALIGNMENT_USES[number];

// 도로구조규칙 제8조 road classes, plus the LH manual's roads inside housing estates (8.1.3 나).
export const ROAD_CLASSES = ["주간선도로(고속국도)", "주간선도로(그 밖의 도로)", "보조간선도로", "집산도로", "국지도로", "공동주택 단지 내 도로"] as const;
export type RoadClass = typeof ROAD_CLASSES[number];
export const APARTMENT_ROAD: RoadClass = "공동주택 단지 내 도로";

// 제8조 areas: rural areas by terrain, and urban areas.
export const REGIONS = ["지방지역(평지)", "지방지역(구릉지)", "지방지역(산지)", "도시지역"] as const;
export type Region = typeof REGIONS[number];

// 제21조 areas for the maximum superelevation.
export const SUPERELEVATION_AREAS = ["지방지역(적설·한랭)", "지방지역(그 밖)", "도시지역", "연결로"] as const;

export type AlignmentRecord = {
  uses?: AlignmentUse[]; criteria?: string; roadClass?: RoadClass; region?: Region;
  area?: string; maxSuperelevation?: number;
};

// Without duplicates, and with 도로 first: when a road is among the uses, the road decides
// the geometry and the Civil 3D type.
export function orderUses(uses: AlignmentUse[]): AlignmentUse[] {
  const unique = [...new Set(uses)];
  return unique.includes("도로") ? ["도로", ...unique.filter(use => use !== "도로")] : unique;
}

export function writeRecord(record: AlignmentRecord): string {
  return [
    record.uses?.length ? `용도: ${record.uses.join(", ")}` : undefined,
    record.criteria ? `기준: ${record.criteria}` : undefined,
    record.roadClass ? `도로 구분: ${record.roadClass}` : undefined,
    record.region ? `지역: ${record.region}` : undefined,
    record.area ? `편경사 지역: ${record.area}` : undefined,
    record.maxSuperelevation !== undefined ? `최대편경사: ${record.maxSuperelevation}%` : undefined
  ].filter(Boolean).join(" / ");
}

const field = (description: string, key: string) =>
  new RegExp(`${key}\\s*:\\s*([^/\\r\\n]+)`).exec(description)?.[1].trim();
const oneOf = <T extends string>(list: readonly T[], value?: string) =>
  value !== undefined && (list as readonly string[]).includes(value) ? value as T : undefined;

// What a description records; fields it does not have stay undefined.
export function readRecord(description?: string | null): AlignmentRecord {
  const text = description ?? "";
  const uses = (field(text, "용도") ?? "").split(/[,，、]/).map(part => part.trim())
    .filter((part): part is AlignmentUse => (ALIGNMENT_USES as readonly string[]).includes(part));
  const criteria = field(text, "기준");
  const emax = Number(field(text, "최대편경사")?.replace("%", ""));
  return {
    ...(uses.length ? { uses } : {}),
    ...(criteria && /^[\w가-힣.-]{1,80}$/.test(criteria) ? { criteria } : {}),
    ...(oneOf(ROAD_CLASSES, field(text, "도로 구분")) ? { roadClass: oneOf(ROAD_CLASSES, field(text, "도로 구분")) } : {}),
    ...(oneOf(REGIONS, field(text, "지역")) ? { region: oneOf(REGIONS, field(text, "지역")) } : {}),
    ...(oneOf(SUPERELEVATION_AREAS, field(text, "편경사 지역")) ? { area: field(text, "편경사 지역") } : {}),
    ...([6, 7, 8].includes(emax) ? { maxSuperelevation: emax } : {})
  };
}

export const readUses = (description?: string | null) => readRecord(description).uses;

// A note for road checks on an alignment whose recorded uses do not include a road.
export function notRoadNote(uses: AlignmentUse[] | undefined): string | undefined {
  return uses && !uses.includes("도로")
    ? `선형 설명의 용도가 ${uses.join(", ")}이라 도로 기준으로 검토하지 않음. 도로이면 설명의 용도에 도로를 넣으세요.`
    : undefined;
}

// 제25조 grade groups and terrain from the 제8조 class and area, when they follow from it.
export function gradeConditions(record: AlignmentRecord): { roadFunction?: string; terrain?: string } {
  const roadFunction = record.roadClass === "주간선도로(고속국도)" ? "고속국도"
    : record.roadClass === "주간선도로(그 밖의 도로)" || record.roadClass === "보조간선도로" ? "주간선·보조간선(그 밖의 도로)"
    : record.roadClass === "집산도로" ? "집산도로·연결로"
    : record.roadClass === "국지도로" ? "국지도로" : undefined;
  const terrain = record.region === "지방지역(평지)" ? "평지"
    : record.region === "지방지역(구릉지)" || record.region === "지방지역(산지)" ? "산지등" : undefined;
  return { ...(roadFunction ? { roadFunction } : {}), ...(terrain ? { terrain } : {}) };
}

// 제21조 area for the maximum superelevation, when the 제8조 area settles it.
export const superelevationArea = (region?: Region) => region === "도시지역" ? "도시지역" : undefined;
