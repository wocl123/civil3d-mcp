import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { clip, logTool } from "../logs/workLog.js";

// Records every tool call of a palette request (the request id comes from the service)
// with its arguments, time taken, output size, and whether it failed, in
// data/logs/<date>/tools.jsonl. The output size is what the call added to the AI's
// context: text characters, and images counted apart.
type ToolOutput = { isError?: boolean; content?: { type: string; text?: string }[] };

export function outputSize(result: ToolOutput | undefined): { outputChars: number; images?: number } {
  const content = result?.content ?? [];
  const images = content.filter(item => item.type === "image").length;
  return { outputChars: content.reduce((sum, item) => sum + (item.text?.length ?? 0), 0), ...(images ? { images } : {}) };
}

export function loggedServer(server: McpServer): McpServer {
  const requestId = process.env.MY_CIVIL3D_REQUEST_ID;
  if (!requestId || requestId === "none") return server;
  return new Proxy(server, {
    get(target, property, receiver) {
      if (property !== "registerTool") return Reflect.get(target, property, receiver);
      return (name: string, config: unknown, callback: (...args: unknown[]) => Promise<ToolOutput>) =>
        (target.registerTool as (...args: unknown[]) => unknown)(name, config, async (...args: unknown[]) => {
          const started = Date.now();
          const input = clip(JSON.stringify(args[0] ?? {}), 500);
          try {
            const result = await callback(...args);
            await logTool({ requestId, tool: name, input, ms: Date.now() - started, ok: !result?.isError, ...outputSize(result) });
            return result;
          } catch (error) {
            await logTool({ requestId, tool: name, input, ms: Date.now() - started, ok: false,
              error: clip(error instanceof Error ? error.message : String(error), 500) });
            throw error;
          }
        });
    }
  });
}
