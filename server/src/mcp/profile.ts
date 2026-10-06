// 도구 프로필.
//   full:    모든 도구 (개발·외부 MCP 클라이언트용)
//   palette: 팔레트 AI용. 읽기 전용 도구 + 동의한 수정안 적용 도구 하나만.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export type McpProfile = "full" | "palette";

export function mcpProfile(): McpProfile {
  return process.env.MY_CIVIL3D_MCP_PROFILE === "palette" ? "palette" : "full";
}

type ToolConfig = { annotations?: { readOnlyHint?: boolean; openWorldHint?: boolean } };

// 팔레트 AI가 받는 유일한 쓰기 도구.
// 검토 도구가 계산하고 앞서 사용자에게 보여 준 수정안만, 사용자가 동의했을 때 적용한다.
// 값은 코드가 계산한 것이고 AI가 정하지 않는다(changeTools.ts).
const PALETTE_WRITE_TOOLS = new Set(["apply_drawing_change"]);

// 팔레트 AI는 사람이 지켜보지 않는 상태로 돈다. 그래서 도면을 바꾸거나 도면 밖 파일을 읽을 수 있는 도구는
// 등록 자체를 하지 않는다(CLI마다 도구 승인 방식이 달라도 상관없게).
//   openWorldHint === false  (도면 밖을 보지 않음)  그리고
//   readOnlyHint === true    (읽기 전용)  또는 위의 쓰기 도구
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
