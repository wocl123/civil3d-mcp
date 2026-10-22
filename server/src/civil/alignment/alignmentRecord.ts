// 선형의 용도와 설계 조건을 선형 설명(Description)에 기록하고 다시 읽는다.
// 예: "용도: 도로, 관망 / 기준: LH_설계지침_토목 / 도로 구분: 집산도로 / 지역: 도시지역 / 편경사 지역: 도시지역 / 최대편경사: 6%"
//
// 왜 기록하나:
//   - Civil 3D의 선형 종류만으로는 관망 선형과 수로 선형을 구분할 수 없다.
//   - 검토에는 설계 때 쓴 기준·도로 구분·지역이 필요하다.
//   도면에 적어 두면 다음 검토에서 다시 묻지 않는다.
// 한 선형이 여러 용도를 가질 수 있다(예: 관망도 따라가는 도로 중심선).

export const ALIGNMENT_USES = ["도로", "관망", "수로/하천", "구조물", "기타"] as const;
export type AlignmentUse = typeof ALIGNMENT_USES[number];

// 도로구조규칙 제8조의 도로 구분 + LH 지침의 공동주택 단지 내 도로(8.1.3 나).
export const ROAD_CLASSES = [
  "주간선도로(고속국도)",
  "주간선도로(그 밖의 도로)",
  "보조간선도로",
  "집산도로",
  "국지도로",
  "공동주택 단지 내 도로"
] as const;
export type RoadClass = typeof ROAD_CLASSES[number];
export const APARTMENT_ROAD: RoadClass = "공동주택 단지 내 도로";

// 제8조 지역 구분: 지방지역(지형별)과 도시지역.
export const REGIONS = ["지방지역(평지)", "지방지역(구릉지)", "지방지역(산지)", "도시지역"] as const;
export type Region = typeof REGIONS[number];

// 제21조 최대 편경사의 지역 구분.
export const SUPERELEVATION_AREAS = ["지방지역(적설·한랭)", "지방지역(그 밖)", "도시지역", "연결로"] as const;

export type AlignmentRecord = {
  uses?: AlignmentUse[];
  criteria?: string;
  roadClass?: RoadClass;
  region?: Region;
  area?: string;              // 편경사 지역
  maxSuperelevation?: number; // 최대 편경사(%)
};

// 중복을 없애고 도로를 맨 앞에. 용도에 도로가 있으면 도로가 형상과 Civil 3D 종류를 정한다.
export function orderUses(uses: AlignmentUse[]): AlignmentUse[] {
  const unique = [...new Set(uses)];
  return unique.includes("도로") ? ["도로", ...unique.filter(use => use !== "도로")] : unique;
}

// 기록을 설명 문자열로 쓴다. 없는 항목은 뺀다.
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

// 설명에서 "키: 값" 하나를 꺼낸다.
const field = (description: string, key: string) =>
  new RegExp(`${key}\\s*:\\s*([^/\\r\\n]+)`).exec(description)?.[1].trim();

// 값이 정해진 목록에 있을 때만 받는다(사람이 손으로 고친 설명의 오타를 거른다).
const oneOf = <T extends string>(list: readonly T[], value?: string) =>
  value !== undefined && (list as readonly string[]).includes(value) ? value as T : undefined;

// 설명에서 기록을 읽는다. 없는 항목은 undefined로 둔다.
export function readRecord(description?: string | null): AlignmentRecord {
  const text = description ?? "";

  const uses = (field(text, "용도") ?? "")
    .split(/[,，、]/)
    .map(part => part.trim())
    .filter((part): part is AlignmentUse => (ALIGNMENT_USES as readonly string[]).includes(part));
  const criteria = field(text, "기준");
  const emax = Number(field(text, "최대편경사")?.replace("%", ""));
  const roadClass = oneOf(ROAD_CLASSES, field(text, "도로 구분"));
  const region = oneOf(REGIONS, field(text, "지역"));

  return {
    ...(uses.length ? { uses } : {}),
    ...(criteria && /^[\w가-힣.-]{1,80}$/.test(criteria) ? { criteria } : {}),
    ...(roadClass ? { roadClass } : {}),
    ...(region ? { region } : {}),
    ...(oneOf(SUPERELEVATION_AREAS, field(text, "편경사 지역")) ? { area: field(text, "편경사 지역") } : {}),
    ...([6, 7, 8].includes(emax) ? { maxSuperelevation: emax } : {})
  };
}

export const readUses = (description?: string | null) => readRecord(description).uses;

// 용도에 도로가 없는 선형이면, 도로 검토 결과에 붙일 안내문.
export function notRoadNote(uses: AlignmentUse[] | undefined): string | undefined {
  return uses && !uses.includes("도로")
    ? `선형 설명의 용도가 ${uses.join(", ")}이라 도로 기준으로 검토하지 않음. 도로이면 설명의 용도에 도로를 넣으세요.`
    : undefined;
}

// 제25조(종단경사)의 도로 기능·지형 구분을 제8조 도로 구분·지역에서 정할 수 있으면 정한다.
export function gradeConditions(record: AlignmentRecord): { roadFunction?: string; terrain?: string } {
  const roadFunction =
    record.roadClass === "주간선도로(고속국도)" ? "고속국도"
    : record.roadClass === "주간선도로(그 밖의 도로)" || record.roadClass === "보조간선도로" ? "주간선·보조간선(그 밖의 도로)"
    : record.roadClass === "집산도로" ? "집산도로·연결로"
    : record.roadClass === "국지도로" ? "국지도로"
    : undefined;

  const terrain =
    record.region === "지방지역(평지)" ? "평지"
    : record.region === "지방지역(구릉지)" || record.region === "지방지역(산지)" ? "산지등"
    : undefined;

  return { ...(roadFunction ? { roadFunction } : {}), ...(terrain ? { terrain } : {}) };
}

// 제8조 지역이 도시지역이면 제21조 편경사 지역도 도시지역으로 정해진다.
export const superelevationArea = (region?: Region) => region === "도시지역" ? "도시지역" : undefined;
