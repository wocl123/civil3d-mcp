// 질문 하나의 토큰 사용량. 모르는 값은 null.
export type TokenUsage = {
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;   // 입력 중 캐시에서 읽은 토큰
  costUsd: number | null;             // Claude만 비용을 알려 준다
};
