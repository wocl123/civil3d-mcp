import { z } from "zod";
import { CRITERIA_SETS } from "../../../criteria/criteriaStore.js";

export const key = z.string().min(1).max(255);

export const criteria = z.enum(CRITERIA_SETS).optional()
  .describe("Criteria set. Default: the one recorded in the alignment's description, else 도로구조규칙 (국토교통부 law). LH_설계지침_토목 is the LH manual over the law.");

export const designSpeed = z.number().int().min(10).max(150).optional()
  .describe("Design speed in km/h. Leave out to use the alignment's design speeds by station.");
