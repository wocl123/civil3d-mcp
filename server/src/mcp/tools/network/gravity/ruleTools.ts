import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { consent } from "../../shared/extensionToolsSchemas.js";
import { text, handle, annotations } from "../../shared/civilToolSchemas.js";
import { z } from "zod";
import { toolResult } from "../../../toolResult.js";
import { planCivil } from "../../shared/planCivil.js";

export function registerNetworkRuleTool(server: McpServer): void {
  server.registerTool("plan_network_rules", {
    title: "Plan explicit gravity-network rule application",
    description: "Apply each selected part's CURRENT rule set to exact part handles within one gravity network. " +
      "Checks the whole network and connected labels for references/locks. Can change slopes, cover, endpoints or " +
      "structure elevations; if any ApplyRules call fails the whole transaction rolls back. Never invent rules." + consent,
    inputSchema: { network: text, handles: z.array(handle).min(1).max(1000) }, annotations
  }, async args => toolResult(await planCivil("network.rules", args)));
}
