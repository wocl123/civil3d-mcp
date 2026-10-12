import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, writeFile, readFile, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const temp = await mkdtemp(join(tmpdir(), 'mycivil3d-github-channel-'));
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const repo = 'test/distribution', bytes = Buffer.from('signed EXE test bytes');
const keyFile = join(temp, 'public.pem');
await writeFile(keyFile, publicKey.export({ type: 'spki', format: 'pem' }));
process.env.MY_CIVIL3D_RELEASE_PUBLIC_KEY_FILE = keyFile;
process.env.MY_CIVIL3D_DATA_DIR = join(temp, 'data');
process.env.MY_CIVIL3D_DRIVE_DIR = join(temp, 'no-drive');
process.env.MY_CIVIL3D_PRODUCT_VERSION = '0.0.1';
process.env.MY_CIVIL3D_INSTALLER_DIR = join(temp, 'no-helper');
let release = { schema: 1, repo, version: '0.0.2', file: 'MyCivil3DMcp-0.0.2-win-x64.exe', size: bytes.length,
 sha256: createHash('sha256').update(bytes).digest('hex'), signature: sign('sha256', bytes, privateKey).toString('base64'),
 publishedAt: new Date().toISOString(), minVersion: '0.0.2', downloadUrl: 'https://github.com/test/distribution/releases/download/v0.0.2/MyCivil3DMcp-0.0.2-win-x64.exe' };
const signed = r => { const p = Buffer.from(JSON.stringify(r)); return JSON.stringify({ schema: 1, payload: p.toString('base64'), signature: sign('sha256', p, privateKey).toString('base64') }); };
let envelope = signed(release), mode = 'ok';
const server = createServer((req, res) => {
 assert.equal(req.headers.authorization, undefined, 'no user GitHub/Google credentials');
 if (req.url.endsWith('/releases/latest')) {
   if (mode === 'missing') { res.writeHead(404); res.end(); return; }
   if (mode === 'limited') { res.writeHead(403); res.end(); return; }
   res.end(JSON.stringify({ tag_name: mode === 'wrong-tag' ? 'v9.9.9' : 'v0.0.2', draft: false, prerelease: false,
    assets: mode === 'incomplete' ? [] : [{ name: 'latest.json', state: 'uploaded' }, { name: 'MyCivil3DMcp-0.0.2-win-x64.exe', state: 'uploaded' }, { name: 'MyCivil3DMcp-9.9.9-win-x64.exe', state: 'uploaded' }] })); return;
 }
 if (req.url.endsWith('/latest.json')) { res.end(envelope); return; }
 if (req.url === '/payload') {
   if (mode === 'large') { res.write(Buffer.alloc(1000)); res.end(Buffer.alloc(1000)); } else res.end(bytes); return;
 }
 if (req.url.endsWith('.exe')) {
   res.writeHead(302, { location: mode === 'evil-redirect' ? 'https://evil.example/payload' : 'https://release-assets.githubusercontent.com/payload' });
   res.end(); return;
 }
 res.writeHead(404); res.end();
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
process.env.MY_CIVIL3D_GITHUB_TEST_BASE = 'http://127.0.0.1:' + server.address().port;
try {
 const { readGitHubRelease, downloadGitHubAsset, validGitHubRelease, validGitHubRepo } = await import('../build/update/githubRelease.js');
 assert.ok(validGitHubRepo(repo));
 for (const r of ['test/..', 'test/x/y', 'test/x?token=x', 'test/x%2fy']) assert.equal(validGitHubRepo(r), false);
 assert.deepEqual(await readGitHubRelease(repo), release);
 assert.deepEqual(await downloadGitHubAsset(release.downloadUrl, bytes.length), bytes);
 assert.throws(() => validGitHubRelease({ ...release, repo: 'evil/repo' }, repo), /형식/);
 assert.throws(() => validGitHubRelease({ ...release, file: '../x.exe' }, repo), /형식/);
 assert.throws(() => validGitHubRelease({ ...release, downloadUrl: 'https://evil.example/x.exe' }, repo), /경로/);
 assert.throws(() => validGitHubRelease({ ...release, minVersion: '99.0.0' }, repo), /최소 버전/);
 mode = 'evil-redirect'; await assert.rejects(downloadGitHubAsset(release.downloadUrl, bytes.length), /허용되지/);
 mode = 'large'; await assert.rejects(downloadGitHubAsset(release.downloadUrl, bytes.length), /크기 제한/);
 mode = 'missing'; assert.equal(await readGitHubRelease(repo), undefined);
 mode = 'limited'; await assert.rejects(readGitHubRelease(repo), /HTTP 403/);
 mode = 'incomplete'; await assert.rejects(readGitHubRelease(repo), /설치파일/);
 mode = 'wrong-tag'; await assert.rejects(readGitHubRelease(repo), /태그/);
 mode = 'ok';
 const forged = JSON.parse(envelope); forged.payload = Buffer.from(JSON.stringify({ ...release, version: '9.9.9' })).toString('base64');
 envelope = JSON.stringify(forged); await assert.rejects(readGitHubRelease(repo), /서명/);
 envelope = signed(release);
 await mkdir(process.env.MY_CIVIL3D_DATA_DIR);
 await writeFile(join(process.env.MY_CIVIL3D_DATA_DIR, 'team.json'), JSON.stringify({ adminEmail: 'test@example.com', githubRepo: repo, releaseManifestId: 'OLD_DRIVE_CHANNEL_12345' }));
 await writeFile(join(process.env.MY_CIVIL3D_DATA_DIR, 'settings.json'), JSON.stringify({ schema: 1, drive: { enabled: false, since: '' } }));
 const { checkForUpdate } = await import('../build/update/autoUpdate.js');
 const result = await checkForUpdate();
 assert.match(result.message, /업데이트 도우미 파일이 없습니다/);
 const cached = join(process.env.MY_CIVIL3D_DATA_DIR, 'updates', release.file);
 assert.deepEqual(await readFile(cached), bytes);
 assert.equal(JSON.parse(await readFile(cached + '.json', 'utf8')).signature, release.signature);
 assert.ok(!existsSync(process.env.MY_CIVIL3D_DRIVE_DIR));
 release = { ...release, signature: sign('sha256', Buffer.from('other bytes'), privateKey).toString('base64') };
 envelope = signed(release);
 assert.match((await checkForUpdate()).message, /설치 EXE 서명/);
 console.log('github release ok: anonymous update, pinned repo/tag/URL, signed metadata and EXE, safe redirects, bounded download, rate-limit/incomplete release refusal, old Drive settings ignored, data sending independent');
} finally {
 server.closeAllConnections(); await new Promise(r => server.close(r));
 if (!resolve(temp).startsWith(join(resolve(tmpdir()), 'mycivil3d-github-channel-'))) throw Error('Invalid cleanup path');
 await rm(temp, { recursive: true, force: true });
}
