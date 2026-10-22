import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { text, annotations, handle, n, point } from "../../shared/civilToolSchemas.js";
import { page, consent } from "../../shared/expansionToolsSchemas.js";
import { toolResult } from "../../../toolResult.js";
import { callPlugin } from "../../../../bridge/pluginClient.js";
import { z } from "zod";
import { planCivil } from "../../shared/planCivil.js";

export function registerPressureRunTools(server: McpServer): void {
  server.registerTool("list_pressure_runs", {
    title: "Read pressure pipe runs and path alignment handles",
    description: "Read exact run names, path alignment handles and constituent parts in one pressure network.",
    inputSchema: { network: text, ...page }, annotations
  }, async args => toolResult(await callPlugin("pressure.runs", args)));

  server.registerTool("plan_pressure_run", {
    title: "Plan pressure pipe run creation, break, merge or profile following",
    description: "pressureRun.create: network/name/source (existing open XY straight-segment polyline), sizeGuid " +
      "from actual Pipe catalog, positive cover and optional autoAddBends (default false). Preserves source. " +
      "pressureRun.break: network/run/point (exact interior XY)/newName. pressureRun.merge: network/run/otherRun. " +
      "pressureRun.profile: network/run/profile belonging to its path alignment, verticalOffset and keepFollow. " +
      "pressureRun.delete: network/run with explicit removeParts and removePath flags. Shows what is deleted/retained. " +
      "Entire network, parts and path alignments checked for locks/references. Values use drawing/API units." + consent,
    inputSchema: { operation: z.enum(["pressureRun.create", "pressureRun.break", "pressureRun.merge",
      "pressureRun.profile", "pressureRun.delete"]), network: text, name: text.optional(), source: handle.optional(),
    removeParts: z.boolean().optional(), removePath: z.boolean().optional(),
    sizeGuid: z.string().uuid().optional(), cover: n.positive().optional(), autoAddBends: z.boolean().optional(),
    run: text.optional(), otherRun: text.optional(), newName: text.optional(), point: point.optional(),
    profile: text.optional(), verticalOffset: n.optional(), keepFollow: z.boolean().optional() }, annotations
  }, async ({ operation, ...args }) => toolResult(await planCivil(operation, args)));
}
