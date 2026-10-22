import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAlignmentQueryTools } from "../alignment/queryTools.js";
import { registerProfileQueryTools } from "../profile/queryTools.js";

export function registerAlignmentTools(server: McpServer): void {
  registerAlignmentQueryTools(server);
  registerProfileQueryTools(server);
}
