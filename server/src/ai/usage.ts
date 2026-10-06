// AI 토큰 사용량: CLI 출력에서 읽고, 서비스가 켜진 뒤의 합계를 셈한다.

import type { Provider } from "./aiCli.js";
import type { TokenUsage } from "./types/TokenUsage.js";
import type { UsageTotals } from "./types/UsageTotals.js";
export type { TokenUsage } from "./types/TokenUsage.js";
export type { UsageTotals } from "./types/UsageTotals.js";

// 객체가 아니면 빈 객체로(출력 형식이 달라도 오류 없이 읽게).
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

// 0 이상의 숫자만 받고, 아니면 null(모름).
function count(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

// 아는 값만 더한다. 하나도 모르면 null.
function sumKnown(values: Array<number | null>): number | null {
  const known = values.filter((value): value is number => value !== null);
  return known.length ? known.reduce((sum, value) => sum + value, 0) : null;
}

// CLI마다 다른 사용량 형식을 하나로 맞춘다.
export function parseUsage(provider: Provider, output: unknown): TokenUsage {
  const data = record(output);

  // Claude: 입력 = 일반 + 캐시 읽기 + 캐시 쓰기. 비용(USD)도 준다.
  if (provider === "claude") {
    const usage = record(data.usage);
    const normal = count(usage.input_tokens);
    const cached = count(usage.cache_read_input_tokens);
    const written = count(usage.cache_creation_input_tokens);
    return {
      inputTokens: sumKnown([normal, cached, written]),
      outputTokens: count(usage.output_tokens),
      cachedInputTokens: cached,
      costUsd: count(data.total_cost_usd)
    };
  }

  // Codex
  if (provider === "codex") {
    const usage = record(data.usage);
    return {
      inputTokens: count(usage.input_tokens),
      outputTokens: count(usage.output_tokens),
      cachedInputTokens: count(usage.cached_input_tokens),
      costUsd: null
    };
  }

  // Gemini: 전체 값이 없으면 모델별 값을 더한다.
  const stats = record(data.stats);
  const models = Object.values(record(stats.models));
  const modelTokens = models.map(model => record(record(model).tokens));
  const modelInput = sumKnown(modelTokens.map(tokens => count(tokens.prompt)));
  const modelOutput = sumKnown(modelTokens.map(tokens => count(tokens.candidates)));
  const modelCached = sumKnown(modelTokens.map(tokens => count(tokens.cached)));
  return {
    inputTokens: count(stats.input_tokens) ?? modelInput,
    outputTokens: count(stats.output_tokens) ?? modelOutput,
    cachedInputTokens: count(stats.cached) ?? modelCached,
    costUsd: null
  };
}

// 서비스가 켜진 뒤 AI별 합계(서비스가 꺼지면 사라진다).
const totals = new Map<Provider, UsageTotals>();

const emptyTotals = (): UsageTotals => ({
  requests: 0, inputTokens: null, outputTokens: null, cachedInputTokens: null, costUsd: null
});

export function addUsage(provider: Provider, usage: TokenUsage): UsageTotals {
  const previous = totals.get(provider) ?? emptyTotals();
  const next: UsageTotals = {
    requests: previous.requests + 1,
    inputTokens: sumKnown([previous.inputTokens, usage.inputTokens]),
    outputTokens: sumKnown([previous.outputTokens, usage.outputTokens]),
    cachedInputTokens: sumKnown([previous.cachedInputTokens, usage.cachedInputTokens]),
    costUsd: sumKnown([previous.costUsd, usage.costUsd])
  };
  totals.set(provider, next);
  return next;
}

export function getUsageTotals(provider: Provider): UsageTotals {
  return totals.get(provider) ?? emptyTotals();
}
