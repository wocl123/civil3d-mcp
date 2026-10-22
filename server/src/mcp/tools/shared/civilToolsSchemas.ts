import { z } from "zod";

export const name = z.string().trim().min(1).max(255);

export const number = z.number().finite();

export const point = z.object({ x: number, y: number, z: number });

export const pvi = z.object({ station: number, elevation: number, curveLength: number.positive().optional() });

export const properties = { newName: name.optional(), description: z.string().max(1000).optional(),
  style: name.optional(), layer: name.optional() };

export const surfaceData = {
  points: z.array(point).min(1).max(10000).optional(),
  breaklines: z.array(z.array(point).min(2).max(1000)).min(1).max(100).optional(),
  boundary: z.array(point).min(3).max(1000).optional()
};

export const annotations = { readOnlyHint: true, openWorldHint: false };

export const consent = " Nothing changes yet. Show all details and ask; only apply the returned option id after agreement.";
