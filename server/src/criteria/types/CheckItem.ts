import type { FixOption } from "./FixOption.js";

// One comparison of a drawing value with a criteria limit.
// "review" means the value misses the table's limit but within what a proviso allows,
// so a person decides whether the proviso applies; "n/a" means it could not be
// compared. The note says why.
export type CheckItem = {
  check: string; article: string; target: string;
  actual?: number; limit?: number; unit: string; bound?: "min" | "max";
  result: "pass" | "fail" | "review" | "n/a";
  note?: string;
  // Ways to fix a failed or review item, computed by the check.
  fixes?: FixOption[];
};
