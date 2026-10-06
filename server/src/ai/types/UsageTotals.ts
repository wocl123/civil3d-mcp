import type { TokenUsage } from "./TokenUsage.js";

// 서비스가 켜진 뒤의 합계(질문 수 포함).
export type UsageTotals = TokenUsage & { requests: number };
