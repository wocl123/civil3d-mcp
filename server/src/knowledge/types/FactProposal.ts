import type { KnowledgeFact } from "./KnowledgeFact.js";

// scope "general": a practice the user stated that holds beyond this drawing; it becomes a
// knowledge candidate for people to approve instead of a drawing fact.
export type FactProposal = Pick<KnowledgeFact, "title" | "content" | "basis" | "evidence"> & { replaces?: string; scope?: "general" };
