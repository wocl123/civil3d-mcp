// Claude Code 상태줄 명령의 진입점(예전 경로 유지용). 실제 코드는 ai/claudeStatusline.ts.
import { runClaudeStatusline } from "./ai/claudeStatusline.js";

// 상태줄은 어떤 경우에도 Claude Code를 방해하면 안 되므로 오류를 삼킨다.
runClaudeStatusline().catch(() => { /* 무시 */ });
