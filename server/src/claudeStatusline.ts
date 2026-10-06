// Keep existing Claude status-line command paths working after the source move.
import { runClaudeStatusline } from "./ai/claudeStatusline.js";

runClaudeStatusline().catch(() => { /* Status line must never interrupt Claude Code. */ });
