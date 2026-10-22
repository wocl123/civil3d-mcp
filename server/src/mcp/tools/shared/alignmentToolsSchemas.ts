import { z } from "zod";

export const key = z.string().min(1).max(255);

export const INLINE_LIMIT = 30;

export type Overview = { sections: Record<string, number> };
