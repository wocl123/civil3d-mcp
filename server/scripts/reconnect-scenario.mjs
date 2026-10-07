// 연결이 끊겼다 이어질 때:
//   A. Civil 3D 브리지가 아직 안 열렸거나, 다른 포트로 다시 열리면 연결 파일을 다시 읽고 기다렸다 보낸다
//   B. 요청을 보낸 뒤 끊기면 다시 보내지 않는다(도면 변경이 두 번 실행되면 안 된다)
//   C. 브리지가 끝내 안 열리면 2초쯤 뒤 오류
//   D. 서비스가 다시 떠도 대화 기억(수정안 id 포함)이 이어지고, 다른 서비스가 쓴 대화를 지우지 않는다
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const temporary = await mkdtemp(join(tmpdir(), 'my-civil3d-reconnect-'));
process.env.MY_CIVIL3D_DATA_DIR = join(temporary, 'data');
process.env.MY_CIVIL3D_CONNECTION_FILE = join(temporary, 'connection.json');
const connection = process.env.MY_CIVIL3D_CONNECTION_FILE;

const { callPlugin } = await import('../build/bridge/pluginClient.js');
const { startFakeCivil } = await import('./fixtures/fake-civil.mjs');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const close = server => new Promise(resolve => server.close(resolve));
const servers = [];

try {
  // A-1. 브리지가 아직 없음(연결 파일도 없음) → 열리면 보낸다
  setTimeout(async () => servers.push(await startFakeCivil(connection)), 700);
  const first = await callPlugin('drawing.status');
  assert.equal(first.drawingName, 'FAKE-SITE.dwg', 'waits for the bridge to open');

  // A-2. 브리지가 닫히고(파일은 옛 포트) 다른 포트로 다시 열림 → 새 포트로 보낸다
  await close(servers.pop());
  setTimeout(async () => servers.push(await startFakeCivil(connection)), 700);
  const second = await callPlugin('drawing.status');
  assert.equal(second.drawingName, 'FAKE-SITE.dwg', 'follows the bridge to its new port');
  await close(servers.pop());

  // B. 받기만 하고 답 없이 끊는 브리지: 한 번만 보내고, 변경 여부는 "알 수 없음"
  let accepted = 0;
  const silent = createServer(socket => { accepted++; socket.once('data', () => socket.destroy()); });
  await new Promise(resolve => silent.listen(0, '127.0.0.1', resolve));
  const { writeFile } = await import('node:fs/promises');
  await writeFile(connection, JSON.stringify({ port: silent.address().port, token: 'a'.repeat(64) }));
  const lost = await callPlugin('change.apply', { changes: [] }).then(() => undefined, error => error);
  assert.ok(lost, 'a lost answer is an error');
  assert.equal(accepted, 1, 'a sent request is not sent again');
  assert.equal(lost.drawingChanged, 'unknown', 'the palette is told the drawing may have changed');
  await close(silent);

  // C. 브리지가 끝내 없음 → 약 2초 뒤 오류
  const started = Date.now();
  const gone = await callPlugin('drawing.status').then(() => undefined, error => error);
  assert.match(gone?.message ?? '', /unavailable/, 'reports the plug-in as unavailable');
  assert.ok(Date.now() - started < 5000, 'gives up within a few seconds');

  // D. 대화 기억이 서비스 재시작 뒤에도 남는다
  const { remember } = await import('../build/workflows/conversation.js');
  remember('reconnect-conv-1', { provider: 'codex', question: '편경사 검토', answer: '수정안 2개', fixIds: ['fx-1', 'fx-2'] });
  const stateFile = join(process.env.MY_CIVIL3D_DATA_DIR, 'state', 'conversations.json');
  for (let i = 0; i < 40 && !(await readFile(stateFile, 'utf8').catch(() => '')).includes('reconnect-conv-1'); i++) await wait(50);

  const module = pathToFileURL(join(process.cwd(), 'build', 'workflows', 'conversation.js')).href;
  const restarted = spawnSync(process.execPath, ['--input-type=module', '-e', `
    const c = await import(${JSON.stringify(module)});
    console.log(JSON.stringify({ fixes: c.offeredFixes('reconnect-conv-1'), turns: c.status('reconnect-conv-1').turns }));
    c.remember('reconnect-conv-2', { provider: 'claude', question: '다른 Civil 3D', answer: '답' });
    await new Promise(r => setTimeout(r, 500));`], { env: process.env, encoding: 'utf8' });
  assert.equal(restarted.status, 0, restarted.stderr);
  assert.deepEqual(JSON.parse(restarted.stdout), { fixes: ['fx-1', 'fx-2'], turns: 1 }, 'a restarted service keeps the conversation and its fixes');

  // 이 서비스가 다시 저장해도 다른 서비스(위 자식 프로세스)의 대화는 남는다
  remember('reconnect-conv-1', { provider: 'codex', question: '1번 적용', answer: '적용함' });
  await wait(500);
  const saved = JSON.parse(await readFile(stateFile, 'utf8'));
  assert.ok(saved['reconnect-conv-2'], "another service's conversation is kept");
  assert.equal(saved['reconnect-conv-1'].turns.length, 2, 'the newer turn is saved');

  console.log('reconnect scenario passed: waits for the bridge, follows a new port, never resends a sent request, gives up in seconds, conversation survives a restart and is shared safely');
} finally {
  for (const server of servers) await close(server);
  await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
