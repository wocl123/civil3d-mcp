import type { CheckItem } from "./CheckItem.js";

export type ConditionValue = { value: string | number; from: "input" | "drawing" | "criteria" };

// What a criteria check tool returns: the document used, the conditions applied
// and where each came from, conditions still needed, and the compared items.
export type CriteriaReport = {
  criteria: { id: string; title: string; effective?: string; reviewed: boolean; verification: string };
  target: string;
  conditions: Record<string, ConditionValue | string>;
  missing: { name: string; options?: (string | number)[]; neededFor: string }[];
  summary: { pass: number; fail: number; review: number; notChecked: number };
  items: CheckItem[];
  omittedPasses?: number;
  notes: string[];
  // What this check never compares, so passing items are not read as a full approval.
  notCovered: string[];
};
