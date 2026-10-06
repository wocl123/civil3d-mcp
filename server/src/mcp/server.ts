import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerDrawingTools } from "./tools/drawingTools.js";
import { registerKnowledgeTools } from "./tools/knowledgeTools.js";
import { registerAlignmentTools } from "./tools/alignmentTools.js";
import { registerCriteriaTools } from "./tools/criteriaTools.js";
import { registerChangeTools } from "./tools/changeTools.js";
import { registerDesignTools } from "./tools/designTools.js";
import { mcpProfile, paletteServer } from "./profile.js";
import { loggedServer } from "./toolLog.js";
import { guidedServer } from "./toolErrors.js";

const server = new McpServer({ name: "my-civil3d-mcp", version: "0.1.0" });
// Errors are logged as thrown, then returned to the AI with their failure guide.
const tools = loggedServer(guidedServer(mcpProfile() === "palette" ? paletteServer(server) : server));
registerDrawingTools(tools);
registerAlignmentTools(tools);
registerCriteriaTools(tools);
registerDesignTools(tools);
registerChangeTools(tools);
registerKnowledgeTools(tools);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("my-civil3d-mcp: stdio connected\n");

  let closing = false;
  const shutdown = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    await server.close();
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
}

main().catch((error: unknown) => {
  process.stderr.write(`my-civil3d-mcp: startup failed: ${String(error)}\n`);
  process.exitCode = 1;
});
