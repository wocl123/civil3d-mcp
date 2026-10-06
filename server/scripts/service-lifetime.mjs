// The local service's lifetime: a service started for a later Civil 3D takes the port from
// a leftover one, and a service exits when the Civil 3D that started it is gone.
// A sleeping Node process stands in for Civil 3D.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const temporary = await mkdtemp(join(tmpdir(), 'my-civil3d-life-'));
const connection = join(temporary, 'connection.json');
const token = 'b'.repeat(64);
await writeFile(connection, JSON.stringify({ port: 1, token }));
const port = 49500 + Math.floor(Math.random() * 400);
const entry = fileURLToPath(new URL('../build/localService.js', import.meta.url));
const exited = child => new Promise(resolve => child.once('exit', () => resolve(true)));
const within = (promise, ms) => Promise.race([promise, new Promise(resolve => setTimeout(() => resolve(false), ms))]);

function civil3d() { return spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']); }
function service(parent) {
  const child = spawn(process.execPath, [entry], { env: { ...process.env, MY_CIVIL3D_CONNECTION_FILE: connection,
    MY_CIVIL3D_SERVICE_PORT: String(port), MY_CIVIL3D_DATA_DIR: join(temporary, 'data'), MY_CIVIL3D_SYNC: 'off',
    MY_CIVIL3D_PARENT_PID: String(parent.pid) }, stdio: ['ignore', 'ignore', 'pipe'] });
  child.ready = new Promise(resolve => child.stderr.on('data', chunk => { if (String(chunk).includes('local service:')) resolve(true); }));
  return child;
}

const first = civil3d(), second = civil3d();
try {
  const old = service(first);
  assert.ok(await within(old.ready, 10000), 'first service starts');
  const fresh = service(second);
  assert.ok(await within(exited(old), 10000), 'the leftover service is asked to stop');
  assert.ok(await within(fresh.ready, 10000), 'the new service takes the port');
  const response = await fetch(`http://127.0.0.1:${port}/api/providers`, { headers: { 'x-my-civil3d-token': token } });
  assert.equal(response.status, 200, 'the new service answers');

  second.kill();
  assert.ok(await within(exited(fresh), 10000), 'the service exits when its Civil 3D is gone');
  console.log('Service lifetime test passed: takeover of a leftover service, exit with Civil 3D.');
} finally {
  first.kill(); second.kill();
  await rm(temporary, { recursive: true, force: true });
}
