// Publish through Drive for Desktop. Verify actual public downloads before announcing a version.
import { createHash, createPrivateKey, sign, verify } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { mkdir, readFile, writeFile, copyFile, mkdtemp, rm } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { sandboxInstall } from './installer-sandbox.mjs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { downloadDriveFile, trustedReleaseKey } = await import('../server/build/update/driveRelease.js');
const { validEmail } = await import('../server/build/data/settings.js');
const { driveFileId } = await import('../server/build/admin/adminConfig.js');


export async function assertDriveAccessible(id, viewBase = 'https://drive.google.com') {
  const response = await fetch(viewBase + '/file/d/' + encodeURIComponent(id) + '/view', { signal: AbortSignal.timeout(30000) });
  if (response.status !== 403 || !response.body) { await response.body?.cancel(); return; }
  const reader = response.body.getReader();
  let size = 0; const chunks = [];
  try {
    while (size < 64 * 1024) {
      const { done, value } = await reader.read(); if (done) break;
      chunks.push(value); size += value.byteLength;
    }
    await reader.cancel();
  } finally { reader.releaseLock(); }
  const html = Buffer.concat(chunks, size).toString('utf8');
  if (/서비스 약관|Terms of Service/i.test(html))
    throw new Error('Google Drive가 설치파일을 서비스 약관 위반으로 차단했습니다. Drive 웹에서 파일의 차단 사유와 검토 요청을 확인하세요. 최신 버전 정보는 게시하지 않았습니다.');
}

export async function publishDrive(config, { waitMs = 15 * 60 * 1000, artifactRoot = join(repo, 'dist') } = {}) {
  const { version, driveRoot, adminEmail, manifestId, installerId, required } = config;
  if (!/^\d+\.\d+\.\d+$/.test(version) || !validEmail(adminEmail) || typeof driveRoot !== 'string'
      || !existsSync(driveRoot) || driveFileId(manifestId ?? '') !== manifestId || driveFileId(installerId ?? '') !== installerId)
    throw new Error('배포 설정(버전, Drive 경로, 관리자 메일, 파일 공유 링크)이 맞지 않습니다.');
  const exe = join(artifactRoot, `MyCivil3DMcp-${version}-win-x64.exe`);
  const bytes = await readFile(exe);
  const signature = (await readFile(exe + '.sig', 'ascii')).trim();
  const publicKey = await trustedReleaseKey();
  if (!verify('sha256', bytes, publicKey, Buffer.from(signature, 'base64')))
    throw new Error('설치 EXE 서명이 맞지 않습니다.');
  const key = createPrivateKey(process.env.MY_CIVIL3D_SIGNING_KEY ??
    await readFile(process.env.MY_CIVIL3D_SIGNING_KEY_FILE, 'utf8'));
  const proof = Buffer.from('MyCivil3DMcp publisher key check');
  if (!verify('sha256', proof, publicKey, sign('sha256', proof, key)))
    throw new Error('배포 서명 키가 공개 키와 다릅니다.');

  // Check the actual embedded channel: a valid but wrongly configured installer must not be published.
  const work = await mkdtemp(join(tmpdir(), 'mycivil3d-publish-'));
  try {
    const team = sandboxInstall(exe, work).team ?? {};
    if (team.adminEmail !== adminEmail || team.releaseManifestId !== manifestId || (config.ingestUrl && team.ingestUrl !== config.ingestUrl))
      throw new Error('EXE 내부 관리자 메일/업데이트 링크가 배포 설정과 다릅니다. 설정을 반영하여 다시 빌드하세요.');
  } finally { await rm(work, { recursive: true, force: true }); }

  const folder = join(resolve(driveRoot), 'MyCivil3DMcp-release');
  const latestExe = join(folder, '설치.exe'), latest = join(folder, 'latest.json');
  await mkdir(folder, { recursive: true });
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const backup = await readFile(latest).catch(() => Buffer.from('{}'));
  const previousEnvelope = JSON.parse(backup.toString('utf8').replace(/^\uFEFF/, ''));
  if (previousEnvelope.payload || previousEnvelope.signature) {
    const payload = Buffer.from(previousEnvelope.payload ?? '', 'base64');
    if (!verify('sha256', payload, publicKey, Buffer.from(previousEnvelope.signature ?? '', 'base64')))
      throw new Error('기존 배포 정보 서명이 맞지 않습니다.');
    const prior = JSON.parse(payload.toString('utf8'));
    const a = prior.version.split('.').map(Number), b = version.split('.').map(Number);
    let order = 0; for (let i = 0; i < 3; i++) if (a[i] !== b[i]) { order = a[i] - b[i]; break; }
    if (order > 0 || (order === 0 && prior.sha256 !== sha256))
      throw new Error('이미 게시한 버전보다 새 버전 번호를 사용하세요.');
  }
  const previousExe = await readFile(latestExe).catch(() => undefined);
  const release = { schema: 1, version, file: `MyCivil3DMcp-${version}-win-x64.exe`,
    size: bytes.length, sha256, signature, downloadId: installerId,
    publishedAt: new Date().toISOString(), ...(required ? { minVersion: version } : {}) };
  const payload = Buffer.from(JSON.stringify(release));
  const envelope = Buffer.from(JSON.stringify({ schema: 1, payload: payload.toString('base64'),
    signature: sign('sha256', payload, key).toString('base64') }, null, 1));
  let metadataChanged = false;
  async function waitFor(id, expected) {
    const until = Date.now() + waitMs;
    let lastError = '';
    do {
      try {
        const remote = await downloadDriveFile(id, expected.length);
        if (remote.equals(expected)) return;
        lastError = '공유 파일이 아직 이전 내용입니다.';
      } catch (error) {
        lastError = error.message;
        if (!process.env.MY_CIVIL3D_DOWNLOAD_BASE && /HTTP (403|404)/.test(lastError)) await assertDriveAccessible(id);
      }
      if (Date.now() >= until) break;
      await delay(Math.min(5000, Math.max(0, until - Date.now())));
    } while (Date.now() < until);
    throw new Error('Drive 게시 확인 실패: ' + lastError);
  }
  try {
    // Overwrite in place to retain the Drive file ID. The channel is updated only after EXE upload.
    await pipeline(createReadStream(exe), createWriteStream(latestExe, { flags: 'w' }));
    console.log('Drive 업로드 확인 중: 설치.exe (공유 다운로드 검증)');
    await waitFor(installerId, bytes);
    await mkdir(join(folder, 'versions', version), { recursive: true });
    await copyFile(exe, join(folder, 'versions', version, '설치.exe'));
    await writeFile(join(folder, 'versions', version, 'latest.json'), envelope);
    metadataChanged = true;
    await writeFile(latest, envelope);
    await waitFor(manifestId, envelope);
  } catch (error) {
    // Restore in place so the old public IDs and valid prior release remain usable.
    if (metadataChanged) await writeFile(latest, backup);
    if (previousExe) await writeFile(latestExe, previousExe);
    throw new Error(error.message + '\n기존 배포를 복원했습니다. Drive 동기화와 파일 링크의 보기 권한을 확인하고 다시 배포하세요.');
  }
  console.log(`Drive 배포 완료: ${version}\n설치 파일: https://drive.google.com/file/d/${installerId}/view\n사용자에게는 고정 배포폴더 공유 링크를 안내하세요.`);
  return release;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const config = JSON.parse((await readFile(resolve(process.argv[2]), 'utf8')).replace(/^\uFEFF/, ''));
  await publishDrive(config);
}
