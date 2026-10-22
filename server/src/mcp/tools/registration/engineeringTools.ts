import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerCivilStyleTools } from "../annotation/styleTools.js";
import { registerCogoTools } from "../point/cogoTools.js";
import { registerVolumeTools } from "../surface/volumeTools.js";
import { registerNetworkPartTools } from "../network/gravity/partTools.js";

export function registerEngineeringTools(server: McpServer): void {
  registerCivilStyleTools(server);
  registerCogoTools(server);
  registerVolumeTools(server);
  registerNetworkPartTools(server);
}
