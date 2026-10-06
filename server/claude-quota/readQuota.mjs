import { tmpdir } from 'node:os';
import { query } from '@anthropic-ai/claude-agent-sdk';

const abort = new AbortController();
const timeout = setTimeout(() => abort.abort(), 30000);

async function* noPrompt() {
  if (!abort.signal.aborted)
    await new Promise(resolve => abort.signal.addEventListener('abort', resolve, { once: true }));
}

try {
  const session = query({
    prompt: noPrompt(),
    options: {
      abortController: abort,
      cwd: tmpdir(),
      tools: [],
      disallowedTools: ['mcp__*']
    }
  });
  await session.initializationResult();
  const usage = await session.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true });
  const limits = usage.rate_limits;
  process.stdout.write(JSON.stringify({
    rate_limits_available: usage.rate_limits_available,
    rate_limits: limits && {
      five_hour: limits.five_hour && {
        utilization: limits.five_hour.utilization,
        resets_at: limits.five_hour.resets_at
      },
      seven_day: limits.seven_day && {
        utilization: limits.seven_day.utilization,
        resets_at: limits.seven_day.resets_at
      }
    }
  }) + '\n');
} catch (error) {
  process.stderr.write(`Claude quota query failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  clearTimeout(timeout);
  abort.abort();
}
