import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerStationEquationTool } from "../alignment/stationEquationTools.js";
import { registerPressureRunTools } from "../network/pressure/runTools.js";
import { registerCatchmentTools } from "../catchment/catchmentTools.js";

export function registerExpansionTools(server: McpServer): void {
  registerStationEquationTool(server);
  registerPressureRunTools(server);
  registerCatchmentTools(server);
}
