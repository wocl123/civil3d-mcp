import type { FixOption } from "./FixOption.js";

// 도면 값 하나를 기준값 하나와 비교한 결과.
//   pass:   기준 만족
//   fail:   기준 미달
//   review: 표의 값에는 못 미치지만 단서가 허용하는 범위 안. 단서 적용 여부는 사람이 판단.
//   n/a:    비교하지 못함. note에 이유.
export type CheckItem = {
  targetRef?: { objectHandle: string; kind: string; elementKey: string };
  check: string;          // 검토 이름 (예: 최소 평면곡선 반지름)
  article: string;        // 조문 (예: 제19조)
  target: string;         // 대상 (예: 곡선 2 (0+900.00~1+050.00))
  actual?: number;        // 도면 값
  limit?: number;         // 기준값
  unit: string;
  bound?: "min" | "max";  // min: 기준값 이상이어야 함 / max: 이하여야 함
  result: "pass" | "fail" | "review" | "n/a";
  note?: string;
  fixes?: FixOption[];    // 미달·review 항목을 고치는 방법(코드가 계산)
};
