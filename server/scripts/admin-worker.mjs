import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AdminWorker } from '../build/admin/adminWorker.js';
import { wrapTerminal } from '../build/admin/terminal.js';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const temporary = await mkdtemp(join(tmpdir(), 'mycivil3d-admin-worker-'));
const file = join(temporary, 'worker.mjs');
const marker = join(temporary, 'late-write.txt');
await writeFile(file, `
import { writeFileSync } from 'node:fs';
let value = 0;
process.on('message', ({id, job}) => {
  if (job.text === 'hang') { while (true) {} }
  if (job.text === 'late') {
    setTimeout(() => { writeFileSync(${JSON.stringify(marker)}, 'late'); process.send({id, value:'late'}); }, 800);
    return;
  }
  if (job.text === 'crash') process.exit(7);
  if (job.text === 'bad') process.send({id, error:'test failure'});
  else process.send({id, value:String(++value)});
});
`);
const worker = new AdminWorker({ file, timeoutMs: 250 });
try {
  assert.equal(await worker.request({ kind: 'command', text: 'ok' }), '1');
  for (let i = 2; i <= 20; i++) {
    assert.equal(await worker.request({ kind: 'command', text: 'ok' }), String(i), 'worker state must persist');
  }
  await assert.rejects(worker.request({ kind: 'command', text: 'bad' }), /test failure/);
  assert.equal(await worker.request({ kind: 'command', text: 'ok' }), '21');
  await assert.rejects(worker.request({ kind: 'command', text: 'hang' }), /중단했습니다/);
  assert.equal(await worker.request({ kind: 'command', text: 'ok' }), '1', 'timeout must allow a new worker');
  const late = worker.request({ kind: 'command', text: 'late' });
  await new Promise(resolve => setTimeout(resolve, 50));
  await worker.cancel();
  await assert.rejects(late, /취소했습니다/);
  await new Promise(resolve => setTimeout(resolve, 900));
  assert.equal(await readFile(marker, 'utf8').catch(() => undefined), undefined,
    'cancelled work must not keep writing in the background');
  assert.equal(await worker.request({ kind: 'command', text: 'ok' }), '1');
  await assert.rejects(worker.request({ kind: 'command', text: 'crash' }), /예기치 않게/);
  assert.equal(await worker.request({ kind: 'command', text: 'ok' }), '1');
  assert.deepEqual(wrapTerminal('가나다라', 4), ['가나', '다라']);
  assert.deepEqual(wrapTerminal('\x1b[2J안녕\r\x00', 10), ['안녕']);
  const parent = join(temporary, 'parent.mjs');
  await writeFile(parent, `
import { AdminWorker } from ${JSON.stringify(pathToFileURL(resolve('build/admin/adminWorker.js')).href)};
const worker = new AdminWorker();
await worker.request({kind:'summary'});
console.log(worker.child.pid);
process.exit(0);
`);
  const detached = spawnSync(process.execPath, [parent], {
    encoding: 'utf8', windowsHide: true, timeout: 10000,
    env: { ...process.env, MY_CIVIL3D_DATA_DIR: join(temporary, 'orphan-data'), MY_CIVIL3D_ADMIN_CONSOLE: '1' }
  });
  assert.equal(detached.status, 0, detached.stderr);
  const pid = Number(detached.stdout.trim());
  assert.ok(Number.isInteger(pid) && pid > 0);
  const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
  for (let i = 0; i < 40 && alive(); i++) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(alive(), false, 'closing the administrator must not leave its worker running');
  console.log('Admin worker passed: persistent state, repeated requests, error recovery, blocked event loop timeout, cancel/no late writes, crash recovery, Korean wrapping, terminal controls.');
} finally {
  await worker.cancel();
  await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
