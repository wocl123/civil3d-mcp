// 명시적으로 지정한 설치 CLI만 사용한다. 사용자 도면 대신 시험 브리지에서 조회 한 번을 수행한다.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFakeCivil } from './fixtures/fake-civil.mjs';

const providers = process.argv.slice(2);
assert.ok(providers.length && providers.every(p => ['claude', 'codex', 'gemini'].includes(p)));
const temp = await mkdtemp(join(tmpdir(), 'mycivil3d-live-performance-'));
process.env.MY_CIVIL3D_DATA_DIR = temp;
process.env.MY_CIVIL3D_CONNECTION_FILE = join(temp, 'connection.json');
process.env.MY_CIVIL3D_SYNC = 'off';
const bridge = await startFakeCivil(process.env.MY_CIVIL3D_CONNECTION_FILE);
const { locateCli } = await import('../build/ai/cliLocator.js');
const { verifyProvider, askProvider } = await import('../build/ai/aiCli.js');
try {
  for (const provider of providers) {
    if (!await locateCli(provider)) {
      console.log(JSON.stringify({ provider, skipped: 'not installed' }));
      continue;
    }

    if (await verifyProvider(provider) !== 'ready') {
      console.log(JSON.stringify({ provider, skipped: 'not authenticated' }));
      continue;
    }

    const timing = {}, tools = [];
    const result = await askProvider(provider,
      'Call list_surfaces exactly once and reply only with the number of surfaces. Do not create plans or change anything.', {
        tools: true, requestId: `live-${provider}`, drawingId: 'fake-drawing-1',
        onTiming: (stage, ms) => { timing[stage] = ms; },
        onEvent: event => { if (event.type === 'tool') tools.push(event.name); }
      });
    assert.ok(tools.includes('list_surfaces'), JSON.stringify({ provider, tools, answer: result.answer }));
    assert.match(result.answer, /\d/);
    console.log(JSON.stringify({ provider, passed: true, tools, timing, usage: result.usage }));
  }
} finally {
  await new Promise(resolve => bridge.close(resolve));
  await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
