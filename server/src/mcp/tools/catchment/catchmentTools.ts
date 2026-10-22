import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { handle, annotations, text, point, n } from "../shared/civilToolSchemas.js";
import { page, consent } from "../shared/expansionToolsSchemas.js";
import { toolResult } from "../../toolResult.js";
import { callPlugin } from "../../../bridge/pluginClient.js";
import { z } from "zod";
import { planCivil } from "../shared/planCivil.js";

export function registerCatchmentTools(server: McpServer): void {
  server.registerTool("list_catchments", {
    title: "Read catchment groups, boundaries and runoff properties",
    description: "Without group: group handles/counts. With exact group handle: paged catchment handles, boundary XYZ, " +
      "runoff coefficient and curve number. Follow hasMore.",
    inputSchema: { group: handle.optional(), ...page }, annotations
  }, async args => toolResult(await callPlugin("catchments.list", args)));

  server.registerTool("plan_catchment", {
    title: "Plan catchment group, boundary creation or explicit runoff property edits",
    description: "catchmentGroup.create: name. catchment.create: name/group exact handle/surface TIN/points XY(z=0), " +
      "optional actual catchment style/layer. Boundary is implicitly closed. catchment.edit: handle plus newName, " +
      "group exact handle, runoffCoefficient (0..1) or curveNumber (1..100). No inferred hydraulic values. " +
      "Discharge point and flow-path wizard edits use the interactive native catchment workflow. " +
      "Creates Civil objects only; does not perform or certify a drainage analysis." + consent,
    inputSchema: { operation: z.enum(["catchmentGroup.create", "catchment.create", "catchment.edit"]),
      name: text.optional(), group: handle.optional(), surface: text.optional(), style: text.optional(),
      layer: text.optional(), points: z.array(point).min(3).max(1000).optional(), handle: handle.optional(),
      newName: text.optional(), runoffCoefficient: n.min(0).max(1).optional(),
      curveNumber: n.int().min(1).max(100).optional()
    }, annotations
  }, async ({ operation, ...args }) => toolResult(await planCivil(operation, args)));
}
