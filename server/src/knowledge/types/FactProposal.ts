import type { KnowledgeFact } from "./KnowledgeFact.js";

import type { ParameterKey } from "../parameters.js";

// scope "general": a practice the user stated that holds beyond this drawing; it becomes a
// knowledge candidate for people to approve instead of a drawing fact. parameter: the
// setting the practice amounts to (knowledge/parameters.ts), which code uses once approved.
export type FactProposal = Pick<KnowledgeFact, "title" | "content" | "basis" | "evidence"> & {
  replaces?: string; scope?: "general"; parameter?: { key: ParameterKey; value: number };
};
