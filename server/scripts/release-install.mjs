// 실제 설치 zip으로 설치와 자동 업데이트를 끝까지 해 본다(package.ps1이 zip을 만든 뒤 실행).
//   node scripts/release-install.mjs <MyCivil3DMcp-x.y.z-win-x64.zip>
// zip을 그대로 푼 폴더(설치 파일 + MyCivil3DMcp.bundle.zip + team.json)로 설치 → 팀 정보(관리자 메일)가 데이터 폴더로 →
// 다시 실행하면 "이미 같은 버전" → 서명 없는/다른 키로 서명한 번들은 거절 → 오래된 작업 폴더·백업 정리 →
// 자동 업데이트: 관리자가 드라이브 보내기 폴더에 넣어 준 배포 버전을 받아 두고, Civil 3D가 꺼지면 도우미가 설치한다.
// 서명: 이 테스트용 임시 키로 번들에 서명하고, 설치 폴더의 공개 키도 그 임시 키로 둔다.
// 설치 대상, 데이터, 드라이브는 모두 임시 폴더다.
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readdir, readFile, rename, rm, utimes, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..', '..');
const zip = resolve(process.argv[2] ?? '');
const version = /^MyCivil3DMcp-(\d+\.\d+\.\d+)-win-x64\.zip$/.exec(basename(zip))?.[1];
assert.ok(version && existsSync(zip), 'usage: release-install.mjs <MyCivil3DMcp-x.y.z-win-x64.zip>');

const temporary = await mkdtemp(join(tmpdir(), 'mycivil3d-release-'));
const plugins = join(temporary, 'plugins');
const data = join(temporary, 'data');
const ps = command => execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command]);
const quote = path => `'${path.replace(/'/g, "''")}'`;

// 테스트용 서명 키(실제 릴리스 키와 다르다)
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = publicKey.export({ format: 'jwk' });
const b64 = value => Buffer.from(value, 'base64url').toString('base64');
const testKeyXml = `<RSAKeyValue><Modulus>${b64(jwk.n)}</Modulus><Exponent>${b64(jwk.e)}</Exponent></RSAKeyValue>`;
const signManifest = async bundle => writeFile(join(bundle, 'Contents', 'manifest.sig'),
  sign('sha256', await readFile(join(bundle, 'Contents', 'manifest.json')), privateKey).toString('base64'));
// 설치 스크립트를 폴더에 둔다. keyXml: 그 폴더가 믿는 공개 키
async function placeScripts(folder, keyXml = testKeyXml) {
  for (const name of ['install.ps1', 'package-common.ps1']) await copyFile(join(repo, 'scripts', name), join(folder, name));
  await writeFile(join(folder, 'release-public-key.xml'), keyXml);
}

// install.ps1을 설치 파일 폴더에서 실행한다. 한글 출력을 UTF-8로 받는다.
function installFrom(folder, ...extra) { return installWith(folder, data, ...extra); }
function installWith(folder, dataDir, ...extra) {
  const args = [`-DestinationRoot ${quote(plugins)}`, `-DataDir ${quote(dataDir)}`, '-SkipRunningCheck', ...extra].join(' ');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
    `[Console]::OutputEncoding=[Text.Encoding]::UTF8; try { & ${quote(join(folder, 'install.ps1'))} ${args}; exit 0 } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }`],
    { encoding: 'utf8' });
  return { code: result.status, out: result.stdout + result.stderr };
}
const installedVersion = async () =>
  JSON.parse((await readFile(join(plugins, 'MyCivil3DMcp.bundle', 'Contents', 'version.json'), 'utf8')).replace(/^﻿/, '')).version;

try {
  // 0) 시험용 번들: 받은 zip(설치 파일 + MyCivil3DMcp.bundle.zip)을 풀고 테스트 키로 서명한 뒤, 같은 형식의 zip을 다시 만든다
  const source = join(temporary, 'zip 그대로');
  const unzip = (from, to) => ps(`Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::ExtractToDirectory(${quote(from)}, ${quote(to)})`);
  const zipDir = (from, to, withBase) => ps(`Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::CreateFromDirectory(${quote(from)}, ${quote(to)}, 'Optimal', $${withBase})`);
  unzip(zip, source);
  assert.ok(existsSync(join(source, 'MyCivil3DMcp.bundle.zip')) && !existsSync(join(source, 'MyCivil3DMcp.bundle')),
    'the release zip carries the bundle as one inner zip (few files to extract by hand)');
  assert.ok(!existsSync(join(source, 'server.json')), 'no central server address any more');
  unzip(join(source, 'MyCivil3DMcp.bundle.zip'), source);
  await rm(join(source, 'MyCivil3DMcp.bundle.zip'));
  await signManifest(join(source, 'MyCivil3DMcp.bundle'));
  const publishSource = join(temporary, 'publish-source');
  await mkdir(publishSource);
  zipDir(join(source, 'MyCivil3DMcp.bundle'), join(publishSource, 'MyCivil3DMcp.bundle.zip'), true);
  for (const name of ['install.ps1', 'package-common.ps1']) await copyFile(join(repo, 'scripts', name), join(publishSource, name));
  await writeFile(join(publishSource, 'release-public-key.xml'), testKeyXml);
  const published = join(temporary, 'publish', basename(zip));
  await mkdir(dirname(published), { recursive: true });
  zipDir(publishSource, published, false);

  // 1) 배포 zip을 그대로 푼 폴더(설치 파일 + MyCivil3DMcp.bundle.zip + team.json): 설치하고 관리자 메일을 데이터 폴더로
  const unpacked = join(temporary, '배포 zip 푼 폴더');
  await mkdir(unpacked);
  await placeScripts(unpacked);
  await copyFile(join(publishSource, 'MyCivil3DMcp.bundle.zip'), join(unpacked, 'MyCivil3DMcp.bundle.zip'));
  await writeFile(join(unpacked, 'team.json'), JSON.stringify({ adminEmail: 'admin@example.com' }));
  const first = installFrom(unpacked);
  assert.equal(first.code, 0, first.out);
  assert.match(first.out, /설치했습니다/, 'the installer unpacks MyCivil3DMcp.bundle.zip itself');
  assert.match(first.out, /관리자\(admin@example\.com\)와 공유하세요/, first.out);
  assert.equal(await installedVersion(), version);
  assert.equal(JSON.parse(await readFile(join(data, 'team.json'), 'utf8')).adminEmail, 'admin@example.com', 'the team mail reaches the data folder');
  // 형식이 틀린 team.json은 건너뛴다(설치는 된다)
  const badTeamData = join(temporary, 'data-bad-team');
  await writeFile(join(unpacked, 'team.json'), JSON.stringify({ adminEmail: 'not a mail' }));
  const badTeam = installWith(unpacked, badTeamData, '-Reinstall');
  assert.equal(badTeam.code, 0, badTeam.out);
  assert.match(badTeam.out, /형식이 맞지 않아 건너뜁니다/);
  assert.ok(!existsSync(join(badTeamData, 'team.json')));
  await rm(join(unpacked, 'team.json'));

  // 2) 번들 폴더로 설치(예전 형식)도 서명과 버전을 확인한다
  await placeScripts(source);
  const backups = async () => (await readdir(plugins)).filter(name => name.startsWith('MyCivil3DMcp.bundle.backup-')).length;
  const same = installFrom(source);
  assert.equal(same.code, 0, same.out);
  assert.match(same.out, /\[완료\] 이미 같은 버전/, 'the same version is not installed again');
  assert.doesNotMatch(same.out, /설치 파일을 복사하고 있습니다/);
  // 서명 없는 번들은 설치하지 않는다
  const signature = join(source, 'MyCivil3DMcp.bundle', 'Contents', 'manifest.sig');
  await rename(signature, signature + '.away');
  const refusedUnsigned = installFrom(source, '-Reinstall');
  await rename(signature + '.away', signature);
  assert.notEqual(refusedUnsigned.code, 0);
  assert.match(refusedUnsigned.out, /서명이 없는 설치 파일입니다/);
  // 다른 키를 믿는 설치 파일(실제 릴리스 키)은 테스트 키로 서명한 번들을 거절한다
  const otherKit = join(temporary, '다른 키 설치 폴더');
  await mkdir(otherKit);
  await placeScripts(otherKit, await readFile(join(repo, 'scripts', 'release-public-key.xml'), 'utf8'));
  await copyFile(join(publishSource, 'MyCivil3DMcp.bundle.zip'), join(otherKit, 'MyCivil3DMcp.bundle.zip'));
  const forged = installFrom(otherKit, '-Reinstall');
  assert.notEqual(forged.code, 0, 'a bundle signed with another key must fail');
  assert.match(forged.out, /서명이 맞지 않습니다/);
  assert.equal(await installedVersion(), version);
  // 끊긴 설치가 남긴 오래된 작업 폴더는 다음 설치 때 지운다
  const stale = join(plugins, '.mycivil3d-stale');
  await mkdir(stale); const old = new Date(Date.now() - 2 * 3600 * 1000); await utimes(stale, old, old);
  await mkdir(join(plugins, 'MyCivil3DMcp.bundle.backup-old'));   // 예전 업데이트가 남긴 백업
  const reinstall = installFrom(source, '-Reinstall');
  assert.equal(reinstall.code, 0, reinstall.out);
  assert.match(reinstall.out, /설치했습니다/);
  assert.ok(!existsSync(stale), 'a stale work folder is removed');
  assert.equal(await backups(), 1, 'only the latest backup is kept');
  assert.ok(!existsSync(join(plugins, 'MyCivil3DMcp.bundle.backup-old')), 'older backups are removed');
  // 더 새 버전이 설치되어 있으면 내려 설치하지 않는다
  const versionFile = join(plugins, 'MyCivil3DMcp.bundle', 'Contents', 'version.json');
  const versionText = await readFile(versionFile, 'utf8');
  await writeFile(versionFile, versionText.replace(/"version":\s*"[^"]+"/, '"version": "99.0.0"'));
  const newer = installFrom(source);
  assert.match(newer.out, /\[완료\] 설치된 버전\(99\.0\.0\)이 이 설치 파일/, 'a newer installed version is kept');
  await writeFile(versionFile, versionText);
  // 설치 파일이 없으면 이유를 알려 주고 멈춘다
  const empty = join(temporary, '빈 폴더');
  await mkdir(empty);
  await placeScripts(empty);
  const nothing = installFrom(empty);
  assert.notEqual(nothing.code, 0);
  assert.match(nothing.out, /설치 파일\(MyCivil3DMcp\.bundle\.zip\)이 없습니다/);

  // 3) 자동 업데이트: 옛 버전(0.0.1)으로 도는 서비스가 드라이브 보내기 폴더의 배포 버전을 받아 두고, Civil 3D가 꺼지면 도우미가 설치한다
  const drive = join(temporary, '내 드라이브');
  const installId = 'abcdef0123456789';
  await writeFile(join(data, 'install.json'), JSON.stringify({ schema: 1, installId, createdAt: new Date().toISOString() }));
  const shared = join(drive, `MyCivil3DMcp-${installId}`, 'admin');
  await mkdir(shared, { recursive: true });
  const bytes = await readFile(published);
  const releaseInfo = { version, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length, file: basename(zip) };
  await copyFile(published, join(shared, basename(zip)));
  const helperSource = join(temporary, 'installer');
  await mkdir(helperSource);
  await placeScripts(helperSource);
  await copyFile(join(repo, 'scripts', 'update.ps1'), join(helperSource, 'update.ps1'));
  const autoRoot = join(temporary, 'plugins-auto');
  const fakeCivil = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
  const updateEnv = { ...process.env, MY_CIVIL3D_DATA_DIR: data, MY_CIVIL3D_DRIVE_DIR: drive, MY_CIVIL3D_PRODUCT_VERSION: '0.0.1', MY_CIVIL3D_INSTALLER_DIR: helperSource,
    MY_CIVIL3D_INSTALL_ROOT: autoRoot, MY_CIVIL3D_PARENT_PID: String(fakeCivil.pid) };
  const updateModule = pathToFileURL(join(repo, 'server', 'build', 'update', 'autoUpdate.js')).href;
  const check = () => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e',
    `const { checkForUpdate } = await import(${JSON.stringify(updateModule)}); console.log(JSON.stringify(await checkForUpdate()));`],
    { env: updateEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  // 관리자가 아직 배포 버전을 넣지 않았으면 아무것도 하지 않는다
  assert.equal(check().state, 'offline');
  // 배포 정보와 다른 파일(아직 동기화 중이거나 손상)은 받지 않는다
  await writeFile(join(shared, 'release.json'), JSON.stringify({ ...releaseInfo, sha256: '0'.repeat(64) }));
  const mismatch = check();
  assert.equal(mismatch.state, 'failed', JSON.stringify(mismatch));
  assert.match(mismatch.message, /배포 정보와 다릅니다/);
  assert.ok(!existsSync(join(data, 'updates', basename(zip))), 'a mismatching file is not kept');
  await writeFile(join(shared, 'release.json'), JSON.stringify(releaseInfo));
  const checked = check();
  assert.deepEqual([checked.state, checked.current, checked.latest], ['scheduled', '0.0.1', version], JSON.stringify(checked));
  assert.ok(existsSync(join(data, 'updates', basename(zip))), 'the new version is copied from the drive and kept');
  await new Promise(done => setTimeout(done, 3000));
  assert.ok(!existsSync(join(autoRoot, 'MyCivil3DMcp.bundle')), 'nothing is installed while Civil 3D is running');
  fakeCivil.kill();   // Civil 3D 종료
  const installedAuto = join(autoRoot, 'MyCivil3DMcp.bundle', 'Contents', 'version.json');
  const updateLog = () => readFile(join(data, 'logs', new Date().toLocaleString('sv-SE').slice(0, 10), 'update.log'), 'utf8').catch(() => '');
  for (let i = 0; i < 90 && !existsSync(installedAuto); i++) await new Promise(done => setTimeout(done, 1000));
  assert.ok(existsSync(installedAuto), `the helper installs after Civil 3D exits\n${await updateLog()}`);
  for (let i = 0; i < 20 && !/완료/.test(await updateLog()); i++) await new Promise(done => setTimeout(done, 500));
  assert.match(await updateLog(), new RegExp(`업데이트 ${version.replace(/\./g, '\\.')} 완료`));

  console.log(`Release install passed: ${version} from the unpacked zip (inner bundle zip, team mail to the data folder, bad team file skipped); bundle folder install checks signature and version (unsigned and other-key bundles refused, same/newer skipped, reinstall); stale work and old backups removed; missing files explained; automatic update from the drive folder (nothing published → nothing, hash mismatch refused, download kept, waits for Civil 3D to exit, signed install).`);
} finally {
  await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
