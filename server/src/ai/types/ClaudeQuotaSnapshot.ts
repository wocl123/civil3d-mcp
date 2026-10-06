import type { ClaudeRateWindow } from "./ClaudeRateWindow.js";

export type ClaudeQuotaSnapshot = {
  capturedAt: number;
  rate_limits: { five_hour?: ClaudeRateWindow; seven_day?: ClaudeRateWindow };
};
