// 팔레트 요청의 도구 호출을 모두 작업 기록(data/logs/<날짜>/tools.jsonl)에 남긴다.
// 요청 id는 서비스가 환경 변수로 넘긴다. 남기는 것: 인자, 걸린 시간, 결과 크기, 실패 여부.
// 결과 크기는 그 호출이 AI 문맥에 더한 양이다(글자 수, 이미지는 따로 센다).

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { clip, logTool } from "../logs/workLog.js";
import { currentRequestId } from "../changes/requestContext.js";

type ToolOutput = { isError?: boolean; content?: { type: string; text?: string }[] };

export function outputSize(result: ToolOutput | undefined): { outputChars: number; images?: number } {
  const content = result?.content ?? [];
  const images = content.filter(item => item.type === "image").length;
  const outputChars = content.reduce((sum, item) => sum + (item.text?.length ?? 0), 0);
  return { outputChars, ...(images ? { images } : {}) };
}

export function loggedServer(server: McpServer): McpServer {
  const failures = new Map<string, ToolOutput>();
  const errors = new Map<string, unknown>();
  return new Proxy(server, {
    get(target, property, receiver) {
      if (property !== "registerTool") {
        return Reflect.get(target, property, receiver);
      }

      return (name: string, config: unknown, callback: (...args: unknown[]) => Promise<ToolOutput>) =>
        (target.registerTool as (...args: unknown[]) => unknown)(name, config, async (...args: unknown[]) => {
          const requestId = currentRequestId();
          if (requestId === "none") {
            return callback(...args);
          }

          const started = Date.now();
          const key = JSON.stringify([requestId, name, args[0] ?? {}]);
          const input = clip(JSON.stringify(args[0] ?? {}), 500);
          try {
            if (errors.has(key)) {
              throw errors.get(key);
            }

            const previous = failures.get(key);
            const result = previous ?? await callback(...args);
            if (result?.isError && failures.size < 64) {
              failures.set(key, result);
            }

            await logTool({
              requestId,
              tool: name,
              input,
              ms: Date.now() - started,
              ok: !result?.isError,
              repeatedFailure: !!previous,
              ...outputSize(result)
            });
            return result;
          } catch (error) {
            const repeatedFailure = errors.has(key);
            if (errors.size < 64) {
              errors.set(key, error);
            }

            const message = clip(error instanceof Error ? error.message : String(error), 500);
            await logTool({ requestId, tool: name, input, ms: Date.now() - started,
              ok: false, repeatedFailure, error: message });
            throw error;
          }
        });
    }
  });
}
