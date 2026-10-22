// MCP 서버 진입점. 실제 코드는 mcp/ 아래에 있고, 설정된 실행 경로가 바뀌지 않게 여기서 불러온다.
import { startStdioServer } from "./mcp/server.js";

startStdioServer().catch((error: unknown) => {
  process.stderr.write(`my-civil3d-mcp: startup failed: ${String(error)}\n`);
  process.exitCode = 1;
});
