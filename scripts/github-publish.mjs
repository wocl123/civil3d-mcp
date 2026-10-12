// Publish only signed binaries/settings, using administrator gh credentials. No source/data uploads. Uses the configured existing project repository.
import { createHash, createPrivateKey, sign, verify } from 'node:crypto';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { sandboxInstall } from './installer-sandbox.mjs';
import { setTimeout as delay } from 'node:timers/promises';
const run = promisify(execFile);
const repoRoot = resolve(import.meta.dirname, '..');
const { trustedReleaseKey } = await import('../server/build/update/driveRelease.js');
const { validGitHubRepo, validGitHubRelease, githubAssetUrl, readGitHubRelease, downloadGitHubAsset } = await import('../server/build/update/githubRelease.js');
const gh = async args => (await run('gh', args, { windowsHide: true, maxBuffer: 1024 * 1024 })).stdout;
export async function prepareGitHubRelease(config, artifactRoot = join(repoRoot, 'dist')) {
  const { version, githubRepo: repo, ingestUrl, adminEmail, required } = config;
  if (!/^\d+\.\d+\.\d+$/.test(version) || !validGitHubRepo(repo) || !ingestUrl || !adminEmail) throw Error('GitHub 배포 설정 오류');
  const file = `MyCivil3DMcp-${version}-win-x64.exe`, exe = join(artifactRoot, file);
  const bytes = await readFile(exe), signature = (await readFile(exe + '.sig', 'ascii')).trim();
  const publicKey = await trustedReleaseKey();
  if (!verify('sha256', bytes, publicKey, Buffer.from(signature, 'base64'))) throw Error('설치 EXE 서명이 맞지 않습니다.');
  const key = createPrivateKey(process.env.MY_CIVIL3D_SIGNING_KEY ?? await readFile(process.env.MY_CIVIL3D_SIGNING_KEY_FILE, 'utf8'));
  const proof = Buffer.from('MyCivil3DMcp GitHub publisher');
  if (!verify('sha256', proof, publicKey, sign('sha256', proof, key))) throw Error('배포 서명 키가 공개 키와 다릅니다.');
  // A signed artifact must also contain the intended updater and data intake settings.
  const work = await mkdtemp(join(tmpdir(), 'mycivil3d-github-publish-'));
  try {
    const team = sandboxInstall(exe, work).team ?? {};
    if (team.githubRepo !== repo || team.ingestUrl !== ingestUrl || team.adminEmail !== adminEmail || team.releaseManifestId)
      throw Error('EXE 내부 업데이트 저장소/자동 수신 설정이 다릅니다. 다시 빌드하세요.');
  } finally {
    if (!resolve(work).startsWith(join(resolve(tmpdir()), 'mycivil3d-github-publish-'))) throw Error('임시 경로 확인 실패');
    await rm(work, { recursive: true, force: true });
  }
  const release = validGitHubRelease({ schema: 1, repo, version, file, size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'), signature, downloadUrl: githubAssetUrl(repo, version, file),
    publishedAt: new Date().toISOString(), ...(required ? { minVersion: version } : {}) }, repo);
  const payload = Buffer.from(JSON.stringify(release));
  const manifest = join(artifactRoot, 'latest.json');
  await writeFile(manifest, JSON.stringify({ schema: 1, payload: payload.toString('base64'), signature: sign('sha256', payload, key).toString('base64') }, null, 2));
  await writeFile(exe + '.sha256', release.sha256 + '  ' + file + '\n');
  return { release, exe, bytes, manifest };
}
export async function publishGitHub(config) {
  const prepared = await prepareGitHubRelease(config);
  const { release, exe, bytes, manifest } = prepared, repo = release.repo, tag = 'v' + release.version;
  let info;
  try { info = JSON.parse(await gh(['repo', 'view', repo, '--json', 'isPrivate'])); }
  catch (error) {
    if (!/Could not resolve to a Repository|HTTP 404/.test(error.stderr ?? '')) throw error;
    throw Error('배포 대상 GitHub 저장소가 없습니다. 기존 프로젝트 저장소 이름을 확인하세요.');
  }
  if (info.isPrivate) throw Error('로그인 없는 설치/업데이트에는 공개 배포용 저장소가 필요합니다. 소스 저장소 공개 전환은 하지 않습니다.');
  await gh(['api', '--method', 'PUT', 'repos/' + repo + '/immutable-releases']);
  let previous;
  try { previous = await readGitHubRelease(repo); }
  catch (error) {
    // Existing project releases used ZIP assets before this signed EXE channel.
    // Allow a strictly older legacy ZIP release; signed channel failures remain fatal.
    const legacy = JSON.parse(await gh(['api', 'repos/' + repo + '/releases/latest']));
    const oldVersion = typeof legacy.tag_name === 'string' ? /^v(\d+\.\d+\.\d+)$/.exec(legacy.tag_name)?.[1] : undefined;
    const oldParts = oldVersion?.split('.').map(Number), nextParts = release.version.split('.').map(Number);
    let older = false;
    if (oldParts) for (let i = 0; i < 3; i++) if (oldParts[i] !== nextParts[i]) { older = oldParts[i] < nextParts[i]; break; }
    if (!older || !Array.isArray(legacy.assets) || legacy.assets.some(a => a.name === 'latest.json')
        || !legacy.assets.some(a => a.name === `MyCivil3DMcp-${oldVersion}-win-x64.zip` && a.state === 'uploaded')) throw error;
    console.log('기존 ZIP Release에서 서명된 EXE 업데이트 채널로 전환합니다.');
  }
  if (previous) {
    const a = previous.version.split('.').map(Number), b = release.version.split('.').map(Number);
    let order = 0; for (let i = 0; i < 3; i++) if (a[i] !== b[i]) { order = a[i] - b[i]; break; }
    if (order > 0 || (order === 0 && previous.sha256 !== release.sha256)) throw Error('이미 게시한 버전보다 새 버전 번호를 사용하세요.');
    if (order === 0) { console.log('동일한 서명된 버전이 이미 게시됐습니다.'); return previous; }
  }
  const notesFile = join(resolve(repoRoot, '.package-work'), 'github-release-notes.md');
  const fs = await import('node:fs/promises'); await fs.mkdir(resolve(repoRoot, '.package-work'), { recursive: true });
  await writeFile(notesFile, `Civil 3D 2025 설치 파일입니다. EXE를 다운로드하여 실행하세요.\n\nGoogle 로그인이나 Drive 설치 없이 관리자 수신 웹 앱에 자동 등록하고 비식별 기록을 전송합니다.\nRelease에는 설치 산출물만 게시하며 사용자 기록과 서명 비밀 키는 포함하지 않습니다.\n설치 파일과 자동 업데이트 정보는 RSA/SHA-256으로 서명했습니다. Windows 게시자(Authenticode) 서명은 아직 없습니다.\n`);
  // Draft until all artifacts are uploaded; never overwrite an existing public release.
  await gh(['release', 'create', tag, exe, exe + '.sig', exe + '.sha256', manifest,
    '--repo', repo, '--draft', '--title', 'My Civil 3D MCP ' + release.version, '--notes-file', notesFile]);
  await gh(['release', 'edit', tag, '--repo', repo, '--draft=false', '--latest']);
  const until = Date.now() + 120000; let published;
  do {
    try { published = await readGitHubRelease(repo); if (published?.sha256 === release.sha256) break; } catch {}
    await delay(2000);
  } while (Date.now() < until);
  if (published?.sha256 !== release.sha256) throw Error('GitHub 릴리스는 게시됐지만 공개 최신 버전 확인이 지연됐습니다. 삭제/재게시하지 말고 확인하세요.');
  const downloaded = await downloadGitHubAsset(published.downloadUrl, published.size);
  if (!downloaded.equals(bytes)) throw Error('GitHub 공개 다운로드가 원본 EXE와 다릅니다.');
  console.log(`GitHub 배포 완료: ${release.version}\n설치 파일: ${release.downloadUrl}\n사용자 안내: https://github.com/${repo}/releases/latest`);
  return release;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const config = JSON.parse((await readFile(resolve(process.argv[2]), 'utf8')).replace(/^\uFEFF/, ''));
  await publishGitHub(config);
}
