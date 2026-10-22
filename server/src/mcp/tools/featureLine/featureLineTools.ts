import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { n, annotations, text, handle } from "../shared/civilToolSchemas.js";
import { toolResult } from "../../toolResult.js";
import { callPlugin } from "../../../bridge/pluginClient.js";
import { consent, points } from "../shared/extensionToolsSchemas.js";
import { z } from "zod";
import { planCivil } from "../shared/planCivil.js";

export function registerFeatureLineTools(server: McpServer): void {
  server.registerTool("list_feature_lines", {
    title: "Read feature lines and WCS elevation points",
    description: "Read feature lines: name/handle, elevations, lengths and ordered points, before editing by index.",
    inputSchema: { offset: n.int().nonnegative().default(0), limit: n.int().min(1).max(50).default(20) }, annotations
  }, async args => toolResult(await callPlugin("featureLine.list", args)));

  server.registerTool("plan_feature_line_create", {
    title: "Plan feature line creation from an existing curve",
    description: "Create a Civil feature line from an exact LINE/ARC/2D or 3D polyline handle, preserving source. " +
      "Optional surface elevation assignment. No implicit grading, Site membership or invented elevations." + consent,
    inputSchema: { name: text, source: handle, layer: text.optional(), style: text.optional(),
      description: z.string().max(1000).optional(), surface: text.optional(),
      insertIntermediate: z.boolean().optional() }, annotations
  }, async args => toolResult(await planCivil("featureLine.create", args)));

  server.registerTool("plan_feature_line_edit", {
    title: "Plan feature line geometry and elevation edits",
    description: "Edit a feature line by exact handle/name: indexed elevations, add/delete PI or elevation points, " +
      "apply surface elevations, name/description/style/layer. Index edits must be separate from topology/surface changes. " +
      "Read current points first; dependent surfaces, grading and corridors can update." + consent,
    inputSchema: { featureLine: text, newName: text.optional(), description: z.string().max(1000).optional(),
      layer: text.optional(), style: text.optional(), surface: text.optional(),
      insertIntermediate: z.boolean().optional(),
      elevations: z.array(z.object({ index: n.int().nonnegative(), elevation: n })).min(1).max(1000).optional(),
      insertPI: points.optional(), deletePI: points.optional(), insertElevation: points.optional(),
      deleteElevation: points.optional() }, annotations
  }, async args => toolResult(await planCivil("featureLine.edit", args)));
}
