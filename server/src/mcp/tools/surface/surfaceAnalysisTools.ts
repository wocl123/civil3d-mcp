import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { callPlugin } from "../../../bridge/pluginClient.js";
import { toolResult } from "../../toolResult.js";
import { planCivil } from "../shared/planCivil.js";
import { text, n, point, annotations, civilPlanConsent as consent } from "../shared/civilToolSchemas.js";

export function registerSurfaceAnalysisTools(server: McpServer): void {
  server.registerTool("get_surface_analysis", {
    title: "Read current TIN elevation and slope analysis bands",
    description: "Read actual band min/max/ACI color. Slopes are rise/run, 0.05=5%.",
    inputSchema: { surface: text }, annotations
  }, async args => toolResult(await callPlugin("surface.analysis", args)));
  server.registerTool("plan_surface_analysis", {
    title: "Plan explicit surface analysis bands or a waterdrop path",
    description: "surface.analysis: surface/kind elevation or slope plus COMPLETE bands [{min,max,color ACI1..255}]. " +
      "Empty bands clears that kind; slopes rise/run, 0.05=5%. Does not silently change shared surface style display. " +
      "surface.waterdrop: surface/point WCS XY/optional layer creates native 3D flow path, not hydraulic analysis." + consent,
    inputSchema: { operation: z.enum(["surface.analysis", "surface.waterdrop"]), surface: text,
      kind: z.enum(["elevation", "slope"]).optional(), bands: z.array(z.object({ min: n, max: n,
        color: n.int().min(1).max(255) })).max(100).optional(), point: point.optional(),
      layer: text.optional() }, annotations
  }, async ({ operation, ...args }) => toolResult(await planCivil(operation, args)));
}
