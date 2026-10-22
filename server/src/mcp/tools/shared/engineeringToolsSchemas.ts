import { z } from "zod";

export const name = z.string().trim().min(1).max(255);

export const number = z.number().finite();

export const point = z.object({ x: number, y: number, z: number });

export const handle = z.string().regex(/^[0-9a-fA-F]{1,16}$/);

export const pointNumber = number.int().min(1).max(4294967294);

export const page = { offset: number.int().min(0).default(0), limit: number.int().min(1).max(50).default(50) };

export const properties = { newName: name.optional(), description: z.string().max(1000).optional(),
  style: name.optional(), layer: name.optional() };

export const catalog = { family: name, size: name };

export const annotations = { readOnlyHint: true, openWorldHint: false };

export const consent = " Nothing changes yet. Show all targets, effects and coordinates, then ask for agreement before applying.";
