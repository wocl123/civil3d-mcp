import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { text, n, annotations, handle, point } from "../../shared/civilToolSchemas.js";
import { z } from "zod";
import { toolResult } from "../../../toolResult.js";
import { callPlugin } from "../../../../bridge/pluginClient.js";
import { consent } from "../../shared/extensionToolsSchemas.js";
import { planCivil } from "../../shared/planCivil.js";

export function registerPressureTools(server: McpServer): void {
  server.registerTool("list_pressure_networks", {
    title: "Read pressure networks, real parts, ports or catalogs",
    description: "No selectors: networks. network: exact parts and connection-port positions/indices. " +
      "catalog=true: pressure parts lists; with partsList: exact size GUIDs/domain/description. Follow hasMore.",
    inputSchema: { network: text.optional(), catalog: z.boolean().optional(), partsList: text.optional(),
      offset: n.int().nonnegative().default(0), limit: n.int().min(1).max(50).default(20) }, annotations
  }, async args => toolResult(await callPlugin("pressure.list", args)));
  server.registerTool("plan_pressure_design", {
    title: "Plan pressure networks, pipes, fittings, appurtenances and port connections",
    description: "pressureNetwork.create requires name, optional partsList/layer. pressureNetwork.edit requires network " +
      "and newName/description/partsList (catalog changes only on EMPTY networks). pressurePart.create requires network/" +
      "name/kind/sizeGuid from actual catalog: Pipe needs start/end CENTERLINE XYZ; " +
      "curved pipes require midPoint and equal Z at all three points. " +
      "Fitting/Appurtenance need position. pressurePart.edit requires exact handle plus newName/description/sizeGuid/" +
      "position or straight-pipe start/end; connectPipe/port/pipePort joins coincident OPEN ports, disconnectPort " +
      "explicitly detaches. All network parts checked for references/locks; limit 1000. Never invent sizes or ports." + consent,
    inputSchema: { operation: z.enum(["pressureNetwork.create", "pressureNetwork.edit", "pressurePart.create",
      "pressurePart.edit"]),
    name: text.optional(), newName: text.optional(), network: text.optional(), partsList: text.optional(),
    layer: text.optional(),
    description: z.string().max(1000).optional(), handle: handle.optional(), kind: z.enum(["Pipe",
      "Fitting", "Appurtenance"]).optional(),
    sizeGuid: z.string().uuid().optional(), start: point.optional(), midPoint: point.optional(),
    end: point.optional(),
    position: point.optional(), connectPipe: handle.optional(), port: n.int().nonnegative().optional(),
    pipePort: n.int().min(0).max(1).optional(), disconnectPort: n.int().nonnegative().optional() }, annotations
  }, async ({ operation, ...args }) => toolResult(await planCivil(operation, args)));
}
