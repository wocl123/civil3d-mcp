import { findRow } from "./criteriaStore.js";
import type { CriteriaTable } from "./types/CriteriaTable.js";

// 제19조 needs the maximum superelevation the design applies. When none is given, the
// 제21조 maximum for the area is used (fromTable).
export function maxSuperelevation(superTable: CriteriaTable, given: number | undefined, area: string | undefined):
  { value: number; fromTable: boolean } | undefined {
  if (given !== undefined) return { value: given, fromTable: false };
  if (!area) return undefined;
  const row = findRow(superTable, { area });
  return typeof row?.value === "number" ? { value: row.value, fromTable: true } : undefined;
}
