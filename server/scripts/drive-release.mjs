import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, writeFile, readFile, rm, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const temp = await mkdtemp(join(tmpdir(), 'mycivil3d-release-channel-'));
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const manifestId = 'TEST_MANIFEST_12345', installerId = 'TEST_INSTALLER_12345';
const bytes = Buffer.from('signed test EXE payload');
const keyFile = join(temp, 'public.pem');
await writeFile(keyFile, publicKey.export({ type: 'spki', format: 'pem' }));
process.env.MY_CIVIL3D_RELEASE_PUBLIC_KEY_FILE = keyFile;
process.env.MY_CIVIL3D_DATA_DIR = join(temp, 'data');
process.env.MY_CIVIL3D_DRIVE_DIR = join(temp, 'nonexistent-drive');
process.env.MY_CIVIL3D_PRODUCT_VERSION = '0.0.1';
process.env.MY_CIVIL3D_INSTALLER_DIR = join(temp, 'no-installer');
let release = { schema: 1, version: '0.0.2', file: 'MyCivil3DMcp-0.0.2-win-x64.exe',
  sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length,
  signature: sign('sha256', bytes, privateKey).toString('base64'),
  downloadId: installerId, publishedAt: new Date().toISOString(), minVersion: '0.0.2' };
const envelope = r => {
  const payload = Buffer.from(JSON.stringify(r));
  return JSON.stringify({ schema: 1, payload: payload.toString('base64'), signature: sign('sha256', payload, privateKey).toString('base64') });
};
let manifest = envelope(release);
const server = createServer((req, res) => {
  assert.equal(req.headers.authorization, undefined, 'users need no Google API credentials');
  const id = new URL(req.url, 'http://localhost').searchParams.get('id');
  if (id === manifestId) { res.end(manifest); return; }
  if (id === installerId) { res.end(bytes); return; }
  if (id === 'OVERSIZE_TEST_ID') { res.write(Buffer.alloc(1024)); res.end(Buffer.alloc(1024)); return; }
  res.writeHead(403); res.end('no access');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
process.env.MY_CIVIL3D_DOWNLOAD_BASE = 'http://127.0.0.1:' + server.address().port + '/download';
try {
  const { readDriveRelease, validDriveRelease, downloadDriveFile } = await import('../build/update/driveRelease.js');
  assert.deepEqual(await readDriveRelease(manifestId), release);
  await assert.rejects(downloadDriveFile('OVERSIZE_TEST_ID', 1000), /크기 제한/);
  await assert.rejects(downloadDriveFile('NO_ACCESS_TEST', 1000), /HTTP 403/);
  assert.throws(() => validDriveRelease({ ...release, file: '../evil.exe' }), /형식/);
  assert.throws(() => validDriveRelease({ ...release, minVersion: '99.0.0' }), /최소 버전/);
  const forged = JSON.parse(manifest); forged.payload = Buffer.from(JSON.stringify({ ...release, version: '9.9.9' })).toString('base64');
  manifest = JSON.stringify(forged);
  await assert.rejects(readDriveRelease(manifestId), /서명/);
  manifest = envelope(release);
  await mkdir(process.env.MY_CIVIL3D_DATA_DIR);
  await writeFile(join(process.env.MY_CIVIL3D_DATA_DIR, 'team.json'), JSON.stringify({ adminEmail: 'admin@example.com', releaseManifestId: manifestId }));
  // Stop data sending; public updates still download and validate without any member folder.
  await writeFile(join(process.env.MY_CIVIL3D_DATA_DIR, 'settings.json'), JSON.stringify({ schema: 1, drive: { enabled: false, since: '' } }));
  const { checkForUpdate } = await import('../build/update/autoUpdate.js');
  const result = await checkForUpdate();
  assert.equal(result.state, 'failed');
  assert.match(result.message, /업데이트 도우미 파일이 없습니다/, 'the only missing part is the intentionally absent installed helper');
  const cached = join(process.env.MY_CIVIL3D_DATA_DIR, 'updates', release.file);
  assert.deepEqual(await readFile(cached), bytes);
  assert.equal(JSON.parse(await readFile(cached + '.json', 'utf8')).signature, release.signature);
  assert.ok(!existsSync(process.env.MY_CIVIL3D_DRIVE_DIR), 'public updates do not create a Drive/member folder');
  release = { ...release, signature: sign('sha256', Buffer.from('other bytes'), privateKey).toString('base64') };
  manifest = envelope(release);
  const badExe = await checkForUpdate();
  assert.match(badExe.message, /설치 EXE 서명/);
  console.log('drive release ok: public updates without member registration, signed channel and EXE, bounded download, data sending independent');
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await rm(temp, { recursive: true, force: true });
}
