import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { failureGuide } from "../errors/failureGuide.js";

// A tool that throws returns its error with the failure guide (errors/failureGuide.ts):
// what it means, what the user can do, and what the AI does next.
export function guidedServer(server: McpServer): McpServer {
  return new Proxy(server, {
    get(target, property, receiver) {
      if (property !== "registerTool") return Reflect.get(target, property, receiver);
      return (name: string, config: unknown, callback: (...args: unknown[]) => Promise<unknown>) =>
        (target.registerTool as (...args: unknown[]) => unknown)(name, config, async (...args: unknown[]) => {
          try { return await callback(...args); }
          catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return { isError: true, content: [{ type: "text" as const, text: JSON.stringify({ error: message, guide: failureGuide(message) }) }] };
          }
        });
    }
  });
}
