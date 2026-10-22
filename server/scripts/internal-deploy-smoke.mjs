// Apply, replace and restore actual internal bundles in a temporary ApplicationPlugins folder.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../..', import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), 'mycivil3d-internal-deploy-'));
const destination = join(temporary, '한글 내부 설치');
const bundle = join(destination, 'MyCivil3DMcp.bundle');
const read = path => readFile(path, 'utf8');
const parse = async path => JSON.parse((await read(path)).replace(/^\uFEFF/, ''));
const digest = async path => createHash('sha256').update(await readFile(path)).digest('hex');
async function run(command, args) {
  const child = spawn(command, args, { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const chunks = [];
  child.stdout.on('data', chunk => chunks.push(chunk));
  child.stderr.on('data', chunk => chunks.push(chunk));
  const code = await new Promise((done, reject) => { child.once('close', done); child.once('error', reject); });
  assert.equal(code, 0, Buffer.concat(chunks).toString('utf8'));
}
const script = join(root, 'scripts/internal-deploy.ps1');
const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-DestinationRoot', destination];
const originalPackage = await read(join(root, 'server/package.json'));
const originalDeploy = await read(join(root, '.drive-deploy.json')).catch(() => undefined);
try {
  await run('powershell.exe', args);
  const first = await read(join(bundle, 'Contents/internal-deployment.json'));
  assert.equal((await parse(join(bundle, 'Contents/version.json'))).channel, 'internal');
  assert.equal(await digest(join(bundle, 'Contents/plugin/MyCivil3DMcp.Plugin.dll')),
    await digest(join(root, 'plugin/bin/Release/net8.0-windows/MyCivil3DMcp.Plugin.dll')));
  await run(process.execPath, [join(root, 'server/scripts/package-smoke.mjs'), bundle]);
  await run('powershell.exe', args);
  assert.notEqual(await read(join(bundle, 'Contents/internal-deployment.json')), first);
  await run('powershell.exe', [...args, '-Restore']);
  assert.equal(await read(join(bundle, 'Contents/internal-deployment.json')), first, 'previous installation restored exactly');
  assert.equal(await read(join(root, 'server/package.json')), originalPackage, 'release version unchanged');
  assert.equal(await read(join(root, '.drive-deploy.json')).catch(() => undefined), originalDeploy, 'public deployment settings unchanged');
  console.log('Internal deployment passed: real bundle install, installed DLL equals build, packaged server/MCP, repeat replacement, exact restore, Korean/space paths, no version/config changes.');
} finally {
  if (!resolve(temporary).startsWith(join(resolve(tmpdir()), 'mycivil3d-internal-deploy-'))) throw Error('Unsafe cleanup');
  await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
