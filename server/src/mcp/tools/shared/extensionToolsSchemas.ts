import { z } from "zod";
import { point } from "./civilToolSchemas.js";

export const points = z.array(point).min(1).max(1000);

export const consent = " Nothing changes until this plan is applied. Show targets, coordinates and effects for agreement.";
