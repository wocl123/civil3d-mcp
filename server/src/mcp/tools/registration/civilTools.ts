import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerNetworkContainerPlans, registerNetworkInventoryTools } from "../network/gravity/networkTools.js";
import { registerProfileViewTools, registerProfilePlans } from "../profile/profileTools.js";
import { registerSurfaceTools } from "../surface/surfaceTools.js";
import { registerDrawingDisplayTool } from "../drawing/displayTools.js";

export function registerCivilTools(server: McpServer): void {
  registerNetworkContainerPlans(server);
  registerProfileViewTools(server);
  registerNetworkInventoryTools(server);
  registerSurfaceTools(server);
  registerProfilePlans(server);
  registerDrawingDisplayTool(server);
}
