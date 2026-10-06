// 기준 문서의 표 하나에서 가져온 기준값.
// 숫자면 그대로 기준값, { divideByDeltaDeg: n } 이면 "n ÷ 곡선 교각(도)" 이 기준값이다.
export type CriteriaValue = number | { divideByDeltaDeg: number };

export type CriteriaRow = {
  when: Record<string, string | number>;  // 이 행이 적용되는 조건 (예: 설계속도 60, 최대 편경사 6)
  value: CriteriaValue;
  source: string;                         // 이 행을 옮겨 온 원문 줄. law:fetch 가 아직 법령에 있는지 확인한다.
};

export type CriteriaTable = {
  id: string;
  article: string;        // 조문 (예: 제19조)
  title: string;          // 표 제목 (예: 최소 평면곡선 반지름)
  unit: string;
  bound: "min" | "max";   // min: 실제값이 기준값 이상이어야 함 / max: 이하여야 함
  keys: string[];         // 행을 고르는 조건 이름들
  note?: string;
  rows: CriteriaRow[];

  // 조문 단서로 기준을 완화할 수 있는 폭 (예: 제8조① 단서: 20 km/h까지 감속).
  relax?: number;

  // 다른 기준을 따르는 기준에서 합쳐진 표면, 그 표가 나온 문서의 약칭.
  document?: string;
};
