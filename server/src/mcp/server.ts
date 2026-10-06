// MCP 서버 본체(stdio). AI CLI가 이 프로세스를 띄우고 도구를 부른다.
//
// 도구 등록은 세 겹으로 감싼다(안쪽부터):
//   paletteServer: 팔레트 프로필이면 읽기 전용 도구 + 동의한 수정안 적용 도구만 등록
//   guidedServer:  도구가 실패하면 오류와 함께 실패 안내를 돌려줌
//   loggedServer:  팔레트 요청이면 도구 호출마다 작업 기록(tools.jsonl)에 남김

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

  // Ctrl+C / 종료 신호에 한 번만 닫는다.
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
