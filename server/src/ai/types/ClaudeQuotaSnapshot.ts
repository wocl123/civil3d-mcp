import type { ClaudeRateWindow } from "./ClaudeRateWindow.js";

// 상태줄에서 받은 Claude 사용 한도(claude-quota.json).
export type ClaudeQuotaSnapshot = {
  capturedAt: number;
  rate_limits: { five_hour?: ClaudeRateWindow; seven_day?: ClaudeRateWindow };
};
