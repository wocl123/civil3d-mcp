import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAlignmentCriteriaTool, registerBulkCriteriaTool } from "../alignment/criteriaTools.js";
import { registerProfileCriteriaTool } from "../profile/criteriaTools.js";

export function registerCriteriaTools(server: McpServer): void {
  registerAlignmentCriteriaTool(server);
  registerProfileCriteriaTool(server);
  registerBulkCriteriaTool(server);
}
