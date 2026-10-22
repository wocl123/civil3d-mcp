import { n } from "./civilToolSchemas.js";

export const page = { offset: n.int().nonnegative().default(0), limit: n.int().min(1).max(50).default(20) };

export const consent = " Nothing changes until the plan is applied with agreement. Show exact targets, values and effects.";
