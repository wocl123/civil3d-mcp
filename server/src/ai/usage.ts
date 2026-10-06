import type { Provider } from "./aiCli.js";
import type { TokenUsage } from "./types/TokenUsage.js";
import type { UsageTotals } from "./types/UsageTotals.js";
export type { TokenUsage } from "./types/TokenUsage.js";
export type { UsageTotals } from "./types/UsageTotals.js";

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function sumKnown(values: Array<number | null>): number | null {
  const known = values.filter((value): value is number => value !== null);
  return known.length ? known.reduce((sum, value) => sum + value, 0) : null;
}

export function parseUsage(provider: Provider, output: unknown): TokenUsage {
  const data = record(output);
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
  if (provider === "codex") {
    const usage = record(data.usage);
    return {
      inputTokens: count(usage.input_tokens),
      outputTokens: count(usage.output_tokens),
      cachedInputTokens: count(usage.cached_input_tokens),
      costUsd: null
    };
  }

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

const totals = new Map<Provider, UsageTotals>();

export function addUsage(provider: Provider, usage: TokenUsage): UsageTotals {
  const previous = totals.get(provider) ?? {
    requests: 0, inputTokens: null, outputTokens: null, cachedInputTokens: null, costUsd: null
  };
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
  return totals.get(provider) ?? {
    requests: 0, inputTokens: null, outputTokens: null, cachedInputTokens: null, costUsd: null
  };
}
