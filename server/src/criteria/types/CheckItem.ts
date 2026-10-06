import type { FixOption } from "./FixOption.js";

// One comparison of a drawing value with a criteria limit.
// "n/a" means it could not be compared; the note says why.
export type CheckItem = {
  check: string; article: string; target: string;
  actual?: number; limit?: number; unit: string; bound?: "min" | "max";
  result: "pass" | "fail" | "n/a";
  note?: string;
  // Ways to fix a failed item, computed by the check.
  fixes?: FixOption[];
};
