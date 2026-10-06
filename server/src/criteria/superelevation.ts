// 최대 편경사 결정.

import { findRow } from "./criteriaStore.js";
import type { CriteriaTable } from "./types/CriteriaTable.js";

// 제19조(최소 반지름)는 설계에 적용한 최대 편경사가 필요하다.
// 주어진 값이 있으면 그것을, 없으면 제21조의 지역별 최대값을 쓴다(fromTable: true).
// 지역도 모르면 정할 수 없다(undefined).
export function maxSuperelevation(superTable: CriteriaTable, given: number | undefined, area: string | undefined):
  { value: number; fromTable: boolean } | undefined {
  if (given !== undefined) return { value: given, fromTable: false };
  if (!area) return undefined;

  const row = findRow(superTable, { area });
  return typeof row?.value === "number" ? { value: row.value, fromTable: true } : undefined;
}
