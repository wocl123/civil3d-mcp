import { z } from "zod";

// Shared bounds for Civil extension tools; domain-specific defaults stay with their tools.
export const text = z.string().trim().min(1).max(255);
export const n = z.number().finite();
export const point = z.object({ x: n, y: n, z: n });
export const handle = z.string().regex(/^[0-9a-fA-F]{1,16}$/);
export const handles = z.array(handle).min(1).max(200);
export const annotations = { readOnlyHint: true, openWorldHint: false };
export const civilPlanConsent = " Nothing changes until applied with agreement. Show targets, inputs and dependency effects.";
