import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export type McpProfile = "full" | "palette";

export function mcpProfile(): McpProfile {
  return process.env.MY_CIVIL3D_MCP_PROFILE === "palette" ? "palette" : "full";
}

type ToolConfig = { annotations?: { readOnlyHint?: boolean; openWorldHint?: boolean } };

// The one write tool the palette AI gets. It applies only a fix computed by the
// check tools and shown to the user earlier in the conversation, with the user's
// agreement; the values come from code, never from the AI (see changeTools.ts).
const PALETTE_WRITE_TOOLS = new Set(["apply_drawing_change"]);

// The palette AI runs unattended, so its profile registers only tools that cannot
// change the drawing or read files outside it, plus the guarded write tool above.
// Other write tools never reach that AI, regardless of how each CLI handles tool approval.
export function paletteServer(server: McpServer): McpServer {
  return new Proxy(server, {
    get(target, property, receiver) {
      if (property !== "registerTool") return Reflect.get(target, property, receiver);
      return (name: string, config: ToolConfig, callback: unknown) => {
        if (config.annotations?.openWorldHint !== false) return undefined;
        if (config.annotations.readOnlyHint !== true && !PALETTE_WRITE_TOOLS.has(name)) return undefined;
        return (target.registerTool as (...args: unknown[]) => unknown)(name, config, callback);
      };
    }
  });
}
