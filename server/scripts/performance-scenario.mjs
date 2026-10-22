// AI 유료 요청과 사용자 도면 없이 실제 HTTP MCP/기존 stdio 및 적용 안전성을 검사한다.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createServer } from 'node:net';
import { writeFile } from 'node:fs/promises';
import { startFakeCivil, setDrawing, bumpRevision, failMethod, setSelection } from './fixtures/fake-civil.mjs';
import { layerInfo } from './fixtures/fake-layers.mjs';

const temp = await mkdtemp(join(tmpdir(), 'mycivil3d-performance-'));
process.env.MY_CIVIL3D_DATA_DIR = temp;
process.env.MY_CIVIL3D_CONNECTION_FILE = join(temp, 'connection.json');
process.env.MY_CIVIL3D_SYNC = 'off';
const bridge = await startFakeCivil(process.env.MY_CIVIL3D_CONNECTION_FILE);
const { openPaletteMcp } = await import('../build/mcp/paletteHost.js');
const { loadFix, appliedFor } = await import('../build/changes/changeStore.js');
const { remember } = await import('../build/workflows/conversation.js');
const { quickApply } = await import('../build/workflows/quickApply.js');
const { answerChat } = await import('../build/workflows/paletteChat.js');
const { readChatContext } = await import('../build/civil/shared/chatContext.js');
const { paletteLaunch } = await import('../build/ai/paletteWorkspace.js');
const { inPaletteContext } = await import('../build/mcp/paletteContext.js');
const { callPlugin } = await import('../build/bridge/pluginClient.js');
const clients = [], leases = [];
async function connect(requestId, offeredFixes = [], drawingId = 'fake-drawing-1') {
  const lease = await openPaletteMcp({ requestId, offeredFixes, drawingId });
  leases.push(lease);
  const client = new Client({ name: 'performance-test', version: '1' });
  clients.push(client);
  await client.connect(new StreamableHTTPClientTransport(new URL(lease.url), { requestInit: { headers: lease.headers } }));
  return { lease, client };
}
async function call(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  return { error: !!result.isError, text: result.content[0]?.text,
    data: result.isError ? undefined : JSON.parse(result.content[0].text) };
}
async function plan(client, name) {
  const result = await call(client, 'plan_layer_create', { layers: [{ name }] });
  assert.equal(result.error, false, result.text);
  return result.data.option.id;
}
try {
  const a = await connect('parallel-a'), b = await connect('parallel-b');
  assert.equal(a.lease.url, b.lease.url, 'one host reused');
  assert.notEqual(a.lease.headers.Authorization, b.lease.headers.Authorization, 'request capabilities differ');
  const listed = await a.client.listTools();
  assert.deepEqual(listed.tools.filter(t => !t.annotations?.readOnlyHint).map(t => t.name), ['apply_drawing_change']);
  const [fixA, fixB] = await Promise.all([plan(a.client, '권한A'), plan(b.client, '권한B')]);
  assert.equal((await loadFix(fixA)).requestId, 'parallel-a');
  assert.equal((await loadFix(fixB)).requestId, 'parallel-b');
  assert.equal((await call(b.client, 'apply_drawing_change', { fixId: fixA })).error, true, 'cross-request apply denied');
  const wrong = await connect('wrong-drawing', [], 'another-drawing');
  assert.equal((await call(wrong.client, 'plan_layer_create', { layers: [{ name: '금지' }] })).error, true);
  const applier = await connect('apply-a', [fixA]);
  assert.equal((await call(applier.client, 'apply_drawing_change', { fixId: fixA })).error, false);
  assert.equal(layerInfo('권한A').name, '권한A');
  assert.equal((await appliedFor('apply-a')).length, 1, 'apply tagged with current request');
  const stale = await connect('stale-apply', [fixB]);
  assert.equal((await call(stale.client, 'apply_drawing_change', { fixId: fixB })).error, true, 'stale revision denied');

  const unauthorized = await fetch(a.lease.url);
  assert.equal(unauthorized.status, 403);
  assert.equal((await fetch(a.lease.url, { headers: { ...a.lease.headers, Origin: 'https://example.com' } })).status, 403);
  await a.lease.close();
  assert.equal((await fetch(a.lease.url, { headers: a.lease.headers })).status, 403, 'completed request revoked');
  await b.client.close();
  await b.lease.close();

  // 세 CLI 모두 동일한 인증 HTTP 서버를 쓰며 사용자 설정/권한은 공유하지 않는다.
  for (const provider of ['claude', 'codex', 'gemini']) {
    const launch = await paletteLaunch(provider, true, 'config-test', [], 'fake-drawing-1', applier.lease);
    if (provider === 'codex') {
      assert.ok(launch.args.some(arg => arg.includes('mcp_servers.civil3d.url=')));
      assert.ok(!launch.args.some(arg => arg.includes('mcp_servers.civil3d.command=')));
    } else {
      const file = provider === 'claude' ? 'claude-mcp.json' : '.agents/mcp_config.json';
      const config = JSON.parse(await readFile(join(launch.cwd, file), 'utf8')).mcpServers.civil3d;
      assert.equal(config.url ?? config.serverUrl, applier.lease.url);
      assert.equal(config.headers.Authorization, applier.lease.headers.Authorization);
      assert.equal(config.command, undefined);
    }
    if (provider === 'gemini') {
      if (process.platform === 'win32') assert.equal(launch.env.USERPROFILE, launch.cwd, 'request profile isolates CLI settings');
      const settings = JSON.parse(await readFile(join(launch.cwd, '.gemini/antigravity-cli/settings.json'), 'utf8'));
      assert.deepEqual(settings.permissions.allow, ['mcp(civil3d/*)']);
      assert.ok(settings.permissions.deny.includes('command(*)'));
      assert.ok(settings.permissions.deny.includes('write_file(*)'));
      assert.ok(!launch.args.includes('--dangerously-skip-permissions'));
    }
  }
  const noTools = await paletteLaunch('gemini', false);
  assert.deepEqual(JSON.parse(await readFile(join(noTools.cwd, '.agents/mcp_config.json'), 'utf8')).mcpServers, {});

  // 단일 계획에 대한 명확한 동의는 AI가 설치되지 않은 시험 환경에서도 즉시 적용된다.
  const quickId = await plan(applier.client, '빠른적용');
  remember('quick-conversation', { provider: 'claude', question: '계획', answer: '빠른적용 레이어를 만듭니다.', fixIds: [quickId] });
  assert.equal(await quickApply('진행하지마', 'quick-conversation', 'negative'), undefined);
  const result = await answerChat('claude', '진행', undefined, 'quick-conversation');
  assert.equal(result.usage.inputTokens, 0);
  assert.equal(result.applied.length, 1);
  assert.ok(layerInfo('빠른적용'));
  assert.equal(await quickApply('진행', 'quick-conversation', 'repeat'), undefined, 'already-used plan not applied again');
  remember('ambiguous-conversation', { provider: 'claude', question: '계획', answer: '둘', fixIds: [fixA, fixB] });
  assert.equal(await quickApply('진행', 'ambiguous-conversation', 'ambiguous'), undefined);
  const guarded = await plan(applier.client, '변경뒤거부');
  remember('guard-conversation', { provider: 'claude', question: '계획', answer: '계획', fixIds: [guarded] });
  bumpRevision();
  await assert.rejects(() => quickApply('적용해줘', 'guard-conversation', 'guarded'), /Drawing changed/);

  setSelection(['B1']);
  const context = await readChatContext();
  assert.equal(context.scope.drawingId, 'fake-drawing-1');
  assert.equal(context.selection.count, 1);
  assert.match(context.outline, /본선/);
  failMethod('drawing.chat_context', 'Method not found.');
  assert.equal((await readChatContext()).scope.drawingId, 'fake-drawing-1', 'old plugin fallback');
  failMethod('drawing.chat_context', 'CAD failed');
  await assert.rejects(readChatContext, /CAD failed/, 'real CAD failures not hidden');
  failMethod('drawing.chat_context', undefined);

  // 세션이 끝난 뒤 이미 실행 중이던 콜백도 새 CAD 요청을 보내면 안 된다.
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => inPaletteContext({requestId:'ended',drawingId:'fake-drawing-1',
    offeredFixes:[],signal:controller.signal}, () => callPlugin('drawing.layer_apply', {})), /request has ended/);
  const originalConnection = process.env.MY_CIVIL3D_CONNECTION_FILE;
  let received;
  const requestReceived = new Promise(resolve => { received = resolve; });
  let slowSocket;
  const slow = createServer(socket => { slowSocket = socket; socket.on('data', () => received()); });
  await new Promise(resolve => slow.listen(0, '127.0.0.1', resolve));
  const slowConnection = join(temp,'slow-connection.json');
  await writeFile(slowConnection,JSON.stringify({port:slow.address().port,token:'a'.repeat(64)}));
  process.env.MY_CIVIL3D_CONNECTION_FILE = slowConnection;
  const cancellable = await connect('cancel-pending');
  const pending = call(cancellable.client, 'plan_layer_create', {layers:[{name:'취소후금지'}]}).catch(() => undefined);
  await requestReceived;
  await cancellable.lease.close();
  await cancellable.client.close();
  await pending;
  await new Promise(resolve => slow.close(resolve));
  assert.ok(slowSocket.destroyed, 'pending CAD connection closed with the request');
  process.env.MY_CIVIL3D_CONNECTION_FILE = originalConnection;

  const samples = { stdioMs: [], reusedHostMs: [] };
  for (let i = 0; i < 4; i++) {
    let started = performance.now();
    const cold = new Client({ name: 'cold-benchmark', version: '1' });
    await cold.connect(new StdioClientTransport({ command: process.execPath,
      args: [fileURLToPath(new URL('../build/index.js', import.meta.url))], stderr: 'pipe',
      env: { ...process.env, MY_CIVIL3D_MCP_PROFILE: 'palette' } }));
    await cold.listTools();
    samples.stdioMs.push(Math.round(performance.now() - started));
    await cold.close();
    started = performance.now();
    const warm = await connect(`benchmark-${i}`);
    await warm.client.listTools();
    samples.reusedHostMs.push(Math.round(performance.now() - started));
    await warm.client.close();
    await warm.lease.close();
  }
  console.log(JSON.stringify({ passed: 'HTTP MCP reuse, parallel authority/logging, revocation and pending cancellation, single writer, drawing/revision guards, three CLI configs, no-AI quick apply, batched context and fallback', samples }));
} finally {
  await Promise.allSettled(clients.map(client => client.close()));
  await Promise.allSettled(leases.map(lease => lease.close()));
  await new Promise(resolve => bridge.close(resolve));
  await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
