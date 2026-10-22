import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { page, annotations, consent, number, pointNumber, point, name, handle } from "../shared/engineeringToolsSchemas.js";
import { toolResult } from "../../toolResult.js";
import { callPlugin } from "../../../bridge/pluginClient.js";
import { z } from "zod";
import { planCivil } from "../shared/planCivil.js";

export function registerCogoTools(server: McpServer): void {
  server.registerTool("list_cogo_points", {
    title: "List Civil COGO points",
    description: "Read COGO point numbers, handles, WCS coordinates, raw descriptions, layers and protection flags. " +
      "These are surveying points, distinct from ordinary AutoCAD POINT entities. Follow hasMore.",
    inputSchema: page, annotations
  }, async args => toolResult(await callPlugin("cogo.list", args)));

  server.registerTool("plan_cogo_point_create", {
    title: "Plan COGO point creation",
    description: "Create COGO points using explicit unique numbers and WCS XYZ coordinates in drawing units. " +
      "Ask for missing numbers/elevations. Existing numbers are never overwritten or silently renumbered. " +
      "Does not apply description keys or edit survey/project databases. Point groups may override displayed styles." + consent,
    inputSchema: { points: z.array(z.object({ number: pointNumber, position: point,
      rawDescription: z.string().max(1000).optional() })).min(1).max(1000),
    style: name.optional(), labelStyle: name.optional(), layer: name.optional() }, annotations
  }, async args => toolResult(await planCivil("cogo.create", args)));

  server.registerTool("plan_cogo_point_edit", {
    title: "Plan COGO point changes",
    description: "Edit exact COGO point handles: position (one), moveBy (many), or elevation (many), raw description, " +
      "style/labelStyle/layer, or number (one). Use at most one coordinate mode. Numbers cannot overwrite existing points. " +
      "Locked, immovable, survey and project points block the whole batch. Description keys are not reapplied." + consent,
    inputSchema: { handles: z.array(handle).min(1).max(1000), position: point.optional(), moveBy: point.optional(),
      elevation: number.optional(), number: pointNumber.optional(), rawDescription: z.string().max(1000).optional(),
      style: name.optional(), labelStyle: name.optional(), layer: name.optional() }, annotations
  }, async args => toolResult(await planCivil("cogo.edit", args)));
}
