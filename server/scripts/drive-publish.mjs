// Real signed installer over a simulated public Drive; never touches the live Drive.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createPrivateKey, sign } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, basename } from 'node:path';
import { sandboxInstall } from '../../scripts/installer-sandbox.mjs';
const exe = resolve(process.argv[2]);
const temp = await mkdtemp(join(tmpdir(), 'mycivil3d-publish-test-'));
const team = sandboxInstall(exe, join(temp, 'sandbox')).team;
assert.ok(team, 'installer contains team.json');
const version = /^MyCivil3DMcp-(\d+\.\d+\.\d+)-win-x64\.exe$/.exec(basename(exe))[1];
const artifacts = join(temp, 'artifacts'), driveRoot = join(temp, 'drive');
const releaseFolder = join(driveRoot, 'MyCivil3DMcp-release');
await mkdir(artifacts);
await mkdir(releaseFolder, { recursive: true });
await copyFile(exe, join(artifacts, basename(exe)));
await copyFile(exe + '.sig', join(artifacts, basename(exe) + '.sig'));
const installerId = 'PUBLISH_INSTALLER_12345', manifestId = team.releaseManifestId;
let mode = 'ok';
const server = createServer(async (req, res) => {
  if (req.url.startsWith('/file/d/')) { res.writeHead(403); res.end('Google Terms of Service violation'); return; }
  const id = new URL(req.url, 'http://localhost').searchParams.get('id');
  if ((mode === 'installer-fails' && id === installerId) || (mode === 'manifest-fails' && id === manifestId)) { res.writeHead(403); res.end('denied'); return; }
  try {
    res.end(await readFile(join(releaseFolder, id === installerId ? '설치.exe' : 'latest.json')));
  } catch { res.writeHead(404); res.end('missing'); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
process.env.MY_CIVIL3D_DOWNLOAD_BASE = 'http://127.0.0.1:' + server.address().port + '/download';
try {
  const { publishDrive, assertDriveAccessible } = await import('../../scripts/drive-publish.mjs');
  await assert.rejects(assertDriveAccessible(installerId, 'http://127.0.0.1:' + server.address().port), /서비스 약관 위반/);
  const { readDriveRelease } = await import('../build/update/driveRelease.js');
  const config = { version, driveRoot, adminEmail: team.adminEmail, manifestId, installerId, required: true };
  const bytes = await readFile(exe), oldExe = Buffer.from('previous installer');
  const reset = async () => { await writeFile(join(releaseFolder, 'latest.json'), '{}'); await writeFile(join(releaseFolder, '설치.exe'), oldExe); };
  await reset(); mode = 'installer-fails';
  await assert.rejects(publishDrive(config, { artifactRoot: artifacts, waitMs: 0 }), /게시 확인 실패/);
  assert.equal(await readFile(join(releaseFolder, 'latest.json'), 'utf8'), '{}');
  assert.deepEqual(await readFile(join(releaseFolder, '설치.exe')), oldExe);
  await reset(); mode = 'manifest-fails';
  await assert.rejects(publishDrive(config, { artifactRoot: artifacts, waitMs: 0 }), /게시 확인 실패/);
  assert.equal(await readFile(join(releaseFolder, 'latest.json'), 'utf8'), '{}');
  assert.deepEqual(await readFile(join(releaseFolder, '설치.exe')), oldExe);
  mode = 'ok';
  await assert.rejects(publishDrive({ ...config, adminEmail: 'wrong@example.com' }, { artifactRoot: artifacts, waitMs: 0 }), /EXE 내부/);
  const published = await publishDrive(config, { artifactRoot: artifacts, waitMs: 0 });
  assert.deepEqual(await readDriveRelease(manifestId), published);
  assert.equal(published.minVersion, version);
  assert.deepEqual(await readFile(join(releaseFolder, '설치.exe')), bytes);
  // An older artifact can never replace a newer signed public version.
  const key = createPrivateKey(process.env.MY_CIVIL3D_SIGNING_KEY ?? await readFile(process.env.MY_CIVIL3D_SIGNING_KEY_FILE, 'utf8'));
  const future = Buffer.from(JSON.stringify({ ...published, version: '99.0.0' }));
  await writeFile(join(releaseFolder, 'latest.json'), JSON.stringify({ schema: 1, payload: future.toString('base64'), signature: sign('sha256', future, key).toString('base64') }));
  await assert.rejects(publishDrive(config, { artifactRoot: artifacts, waitMs: 0 }), /새 버전 번호/);
  console.log('drive publish ok: upload ordering, signed public download, wrong team rejected, failed EXE/channel restores prior release, older versions refused');
} finally {
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  await rm(temp, { recursive: true, force: true });
}
