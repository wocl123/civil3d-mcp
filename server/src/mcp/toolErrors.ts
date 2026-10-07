// 도구가 실패하면 오류와 실패 안내(errors/failureGuide.ts)를 함께 돌려준다:
// 무슨 뜻인지, 사용자가 할 일, AI가 다음에 할 일.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withDrawing } from "../bridge/boundOperation.js";
import { failureGuide } from "../errors/failureGuide.js";

export function guidedServer(server: McpServer): McpServer {
  return new Proxy(server, {
    get(target, property, receiver) {
      if (property !== "registerTool") return Reflect.get(target, property, receiver);

      // 등록할 때 도구 함수를 감싼다: 던진 오류를 isError 결과로 바꾼다.
      return (name: string, config: unknown, callback: (...args: unknown[]) => Promise<unknown>) =>
        (target.registerTool as (...args: unknown[]) => unknown)(name, config, async (...args: unknown[]) => {
          try {
            return await (name === "apply_drawing_change" || name === "read_knowledge_rule" ? callback(...args) : withDrawing(() => callback(...args)));
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const details = error as { kind?: string; drawingChanged?: boolean | "unknown" };
            const guide = { ...failureGuide(message), ...(details.kind ? { kind: details.kind } : {}),
              ...(details.drawingChanged !== undefined ? { drawingChanged: details.drawingChanged } : {}) };
            const text = JSON.stringify({ error: message, guide });
            return { isError: true, content: [{ type: "text" as const, text }] };
          }
        });
    }
  });
}
