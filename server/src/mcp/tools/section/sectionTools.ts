import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { consent, points } from "../shared/extensionToolsSchemas.js";
import { z } from "zod";
import { n, text, point, handle, annotations } from "../shared/civilToolSchemas.js";
import { toolResult } from "../../toolResult.js";
import { planCivil } from "../shared/planCivil.js";

export function registerSectionTools(server: McpServer): void {
  server.registerTool("plan_section_design", {
    title: "Plan sample groups, source sampling, sample lines and section views",
    description: "sampleGroup.create requires name/alignment; sampleGroup.edit requires group/sources; " +
      "sampleLine.create requires group/name and explicit WCS XY points with z=0 crossing the alignment; " +
      "sampleLine.edit: sampleLine plus station, leftWidth/rightWidth (perpendicular; straight lines only), " +
      "vertices [{index,point}] (non-center only, separate from station/width), newName or lockToStation. " +
      "sampleLine.batch: group/name prefix/startStation/endStation/interval/leftWidth/rightWidth, max 200. " +
      "Names prefix-1 etc.; end included only on interval. Station equations refused for station/width edits. " +
      "sectionView.create requires sampleLine/name/position; sectionView.edit requires sectionView plus position or " +
      "paired elevationMin/Max or offsetLeft/Right. Select actual source handles from sampleGroups first. " +
      "No material quantities are inferred." + consent,
    inputSchema: { operation: z.enum(["sampleGroup.create", "sampleGroup.edit", "sampleLine.create",
      "sampleLine.edit", "sampleLine.batch", "sectionView.create", "sectionView.edit"]),
    station: n.optional(), startStation: n.optional(), endStation: n.optional(), interval: n.positive().optional(),
    leftWidth: n.positive().optional(), rightWidth: n.positive().optional(), newName: text.optional(),
    lockToStation: z.boolean().optional(),
    vertices: z.array(z.object({ index: n.int().nonnegative(), point })).min(1).max(1000).optional(),
    name: text.optional(), alignment: text.optional(), group: text.optional(), sampleLine: text.optional(),
    sectionView: text.optional(), position: point.optional(), points: points.optional(),
    sources: z.array(z.object({ handle, sampled: z.boolean() })).min(1).max(100).optional(),
    elevationMin: n.optional(), elevationMax: n.optional(), offsetLeft: n.optional(),
    offsetRight: n.optional() }, annotations
  }, async ({ operation, ...args }) => toolResult(await planCivil(operation, args)));
}
