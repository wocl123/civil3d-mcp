import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { name, annotations, consent, number, properties } from "../shared/engineeringToolsSchemas.js";
import { toolResult } from "../../toolResult.js";
import { callPlugin } from "../../../bridge/pluginClient.js";
import { planCivil } from "../shared/planCivil.js";
import { z } from "zod";

export function registerVolumeTools(server: McpServer): void {
  server.registerTool("get_volume_surface", {
    title: "Read TIN volume results",
    description: "Read a TIN volume surface's base/comparison surfaces, cut/fill factors, unadjusted and adjusted " +
      "cut/fill/net volumes. Values are in cubic drawing units; do not label them m³ unless drawing units are metres.",
    inputSchema: { surface: name }, annotations
  }, async args => toolResult(await callPlugin("volume.get", args)));

  server.registerTool("plan_volume_surface_create", {
    title: "Plan TIN volume surface creation",
    description: "Create a volume surface from TWO different existing nonempty TIN surfaces. Specify base and " +
      "comparison deliberately; swapping them reverses cut/fill meaning. Factors default to 1. XY ranges must " +
      "overlap; actual shared triangles are checked at apply and creation rolls back if none exist. " +
      "Source surfaces stay unchanged. Never invent terrain or shrink/swell factors." + consent,
    inputSchema: { name, baseSurface: name, comparisonSurface: name,
      cutFactor: number.positive().default(1), fillFactor: number.positive().default(1),
      description: properties.description, style: name.optional(), layer: name.optional() }, annotations
  }, async args => toolResult(await planCivil("volume.create", args)));

  server.registerTool("plan_volume_surface_edit", {
    title: "Plan TIN volume surface changes",
    description: "Change a TIN volume surface's name, description, style/layer, cut/fill factors or rebuild. " +
      "Does not replace its base/comparison references or edit source terrain. Recomputes volume results." + consent,
    inputSchema: { surface: name, ...properties, cutFactor: number.positive().optional(),
      fillFactor: number.positive().optional(), rebuild: z.boolean().optional() }, annotations
  }, async args => toolResult(await planCivil("volume.edit", args)));
}
