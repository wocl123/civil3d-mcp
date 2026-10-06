import assert from 'node:assert/strict';
import { parseUsage, addUsage, getUsageTotals } from '../build/ai/usage.js';
import { parseCodexQuota, parseClaudeQuota, parseClaudeSdkQuota } from '../build/ai/quota.js';
import { parseClaudeStatusline } from '../build/ai/claudeStatusline.js';

const claude = parseUsage('claude', {
  usage: { input_tokens: 50, cache_read_input_tokens: 10, cache_creation_input_tokens: 2, output_tokens: 20 },
  total_cost_usd: 0.03
});
assert.deepEqual(claude, { inputTokens: 62, outputTokens: 20, cachedInputTokens: 10, costUsd: 0.03 });

const codex = parseUsage('codex', { usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 30 } });
assert.equal(codex.inputTokens, 100);
assert.equal(codex.cachedInputTokens, 40);

const gemini = parseUsage('gemini', { stats: { models: {
  'gemini-flash': { tokens: { prompt: 25, candidates: 12, cached: 5 } },
  'gemini-pro': { tokens: { prompt: 15, candidates: 7, cached: 3 } }
} } });
assert.equal(gemini.inputTokens, 40);
assert.equal(gemini.outputTokens, 19);
assert.equal(gemini.cachedInputTokens, 8);

addUsage('claude', claude);
const totals = addUsage('claude', claude);
assert.equal(totals.requests, 2);
assert.equal(getUsageTotals('claude').inputTokens, 124);

const quota = parseCodexQuota({ rateLimits: {
  primary: { usedPercent: 40, windowDurationMins: 300, resetsAt: 1790000000 },
  secondary: { usedPercent: 25, windowDurationMins: 10080, resetsAt: 1790500000 }
}, ordinaryUsageAllowed: true });
assert.equal(quota.status, 'available');
assert.equal(quota.windows[0].label, '5시간');
assert.equal(quota.windows[0].remainingPercent, 60);
assert.equal(quota.windows[1].remainingPercent, 75);

const now = Date.now();
const snapshot = parseClaudeStatusline({ rate_limits: {
  five_hour: { used_percentage: 48, resets_at: Math.floor(now / 1000) + 3600 },
  seven_day: { used_percentage: 40, resets_at: Math.floor(now / 1000) + 86400 }
} }, now);
assert.ok(snapshot);
const claudeQuota = parseClaudeQuota(snapshot, now);
assert.equal(claudeQuota.status, 'available');
assert.equal(claudeQuota.windows[0].remainingPercent, 52);
assert.equal(claudeQuota.windows[1].remainingPercent, 60);
assert.equal(parseClaudeQuota(snapshot, now + 3600_001).status, 'unavailable');
assert.equal(parseClaudeStatusline({ rate_limits: {} }, now), null);
const directClaudeQuota = parseClaudeSdkQuota({ rate_limits_available: true, rate_limits: {
  five_hour: { utilization: 2, resets_at: '2026-10-01T09:19:59Z' },
  seven_day: { utilization: 50, resets_at: '2026-10-02T10:59:59Z' }
} });
assert.equal(directClaudeQuota.status, 'available');
assert.equal(directClaudeQuota.windows[0].remainingPercent, 98);
assert.equal(directClaudeQuota.windows[1].remainingPercent, 50);
process.stdout.write('Usage and quota parsing smoke test passed.\n');
