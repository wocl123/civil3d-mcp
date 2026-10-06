import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const temporary = await mkdtemp(join(tmpdir(), 'my-civil3d-service-'));
const token = 'a'.repeat(64);
const bridge = createServer(socket => {
  let line = '';
  socket.on('data', chunk => {
    line += chunk.toString('utf8');
    if (!line.includes('\n')) return;
    const request = JSON.parse(line.slice(0, line.indexOf('\n')));
    assert.equal(request.token, token);
    const result = request.method === 'drawing.status'
      ? { drawingName: 'sample.dwg', civilDocumentAvailable: true }
      : { totalCount: 1, items: [{ type: 'Line' }] };
    socket.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
  });
});
await new Promise(resolve => bridge.listen(0, '127.0.0.1', resolve));
const bridgePort = bridge.address().port;
await writeFile(join(temporary, 'connection.json'), JSON.stringify({ port: bridgePort, token }));

const availablePort = createServer();
await new Promise(resolve => availablePort.listen(0, '127.0.0.1', resolve));
const uiPort = availablePort.address().port;
await new Promise(resolve => availablePort.close(resolve));

const child = spawn(process.execPath, ['build/localService.js'], {
  cwd: new URL('../', import.meta.url),
  env: { ...process.env, MY_CIVIL3D_CONNECTION_FILE: join(temporary, 'connection.json'), MY_CIVIL3D_SERVICE_PORT: String(uiPort), MY_CIVIL3D_DATA_DIR: join(temporary, 'data'), MY_CIVIL3D_SYNC: 'off' },
  stdio: ['ignore', 'ignore', 'pipe'],
  windowsHide: true
});
let errors = '';
child.stderr.on('data', data => { errors += data.toString('utf8'); });
const base = `http://127.0.0.1:${uiPort}`;

try {
  let ready = false;
  for (let attempt = 0; attempt < 50; attempt++) {
    try { await fetch(base + '/api/providers'); ready = true; break; }
    catch { await new Promise(resolve => setTimeout(resolve, 100)); }
  }
  assert.ok(ready, `Service did not start: ${errors}`);
  const noToken = await fetch(base + '/api/providers');
  assert.equal(noToken.status, 403);
  const headers = { 'X-My-Civil3D-Token': token };

  const drawing = await fetch(base + '/api/drawing', { headers });
  assert.equal(drawing.status, 200);
  assert.equal((await drawing.json()).status.drawingName, 'sample.dwg');

  const providers = await fetch(base + '/api/providers', { headers });
  assert.equal(providers.status, 200);
  assert.equal((await providers.json()).providers.length, 3);

  const usage = await fetch(base + '/api/usage?provider=claude', { headers });
  assert.equal(usage.status, 200);
  assert.equal((await usage.json()).totals.requests, 0);

  const quota = await fetch(base + '/api/quota?provider=gemini', { headers });
  assert.equal(quota.status, 200);
  assert.equal((await quota.json()).quota.status, 'unsupported');

  const chat = await fetch(base + '/api/chat', {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: 'claude', message: 'Hello' })
  });
  assert.equal(chat.status, 403);

  const crossOrigin = await fetch(base + '/api/provider/check', {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/json', Origin: 'http://example.com' },
    body: JSON.stringify({ provider: 'claude' })
  });
  assert.equal(crossOrigin.status, 403);
  process.stdout.write('Local service and plugin bridge smoke test passed.\n');
} finally {
  child.kill();
  await new Promise(resolve => bridge.close(resolve));
  await rm(temporary, { recursive: true, force: true });
}
