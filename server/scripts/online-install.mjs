// 온라인 설치를 실제 설치 zip으로 끝까지 해 본다(package.ps1이 zip을 만든 뒤 실행).
//   node scripts/online-install.mjs <MyCivil3DMcp-x.y.z-win-x64.zip>
// 중앙 서버에 zip을 넣고 배포 지정 → 설치 파일만 있는 폴더(server.json + install.ps1)로 설치 →
// 다시 실행하면 "이미 최신" → 서버 정보와 다른 파일은 거절 → 서비스가 가입 요청으로 중앙에 등록 →
// 서버가 꺼졌고 설치 파일도 없으면 안내 → 사용자에게 줄 설치 묶음(kit)에 server.json이 들어감.
// 서명: 이 테스트용 임시 키로 번들에 서명하고, 설치 폴더의 공개 키도 그 임시 키로 둔다.
//   서명 없는 번들, 다른 키로 서명한 번들, 서명 없는/틀린 zip(중앙)은 거절된다.
// 설치 대상과 데이터는 모두 임시 폴더다.
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { generateKeyPairSync, sign } from 'node:crypto';
import { cp, copyFile, mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..', '..');
const zip = resolve(process.argv[2] ?? '');
const version = /^MyCivil3DMcp-(\d+\.\d+\.\d+)-win-x64\.zip$/.exec(basename(zip))?.[1];
assert.ok(version && existsSync(zip), 'usage: online-install.mjs <MyCivil3DMcp-x.y.z-win-x64.zip>');

const temporary = await mkdtemp(join(tmpdir(), 'mycivil3d-online-'));
const centralData = join(temporary, 'central');
const kit = join(temporary, '설치 폴더');            // 한글·공백 경로
const plugins = join(temporary, 'plugins');
const data = join(temporary, 'data');
await mkdir(kit, { recursive: true });
// 운영체제가 내준 빈 포트. 고정 범위의 무작위 포트는 Windows가 예약한 범위(Hyper-V 등)에 걸리면 열리지 않는다.
const freePort = async () => { const probe = (await import('node:net')).createServer(); await new Promise(r => probe.listen(0, '127.0.0.1', r)); const { port } = probe.address(); await new Promise(r => probe.close(r)); return port; };
const port = await freePort();
const centralEnv = { ...process.env, CENTRAL_DATA_DIR: centralData, CENTRAL_PORT: String(port) };
const releaseCli = join(repo, 'central', 'build', 'release.js');
const cli = (...args) => execFileSync(process.execPath, [releaseCli, ...args], { env: centralEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const cliFails = (...args) => { try { cli(...args); return ''; } catch (error) { return String(error.stderr ?? error.message); } };
const ps = command => execFileSync('powershell.exe', ['-NoProfile', '-Command', command]);
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
function install(...extra) { return installFrom(kit, ...extra); }
function installFrom(folder, ...extra) {
  const args = [`-DestinationRoot ${quote(plugins)}`, `-DataDir ${quote(data)}`, '-SkipRunningCheck', ...extra].join(' ');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
    `[Console]::OutputEncoding=[Text.Encoding]::UTF8; try { & ${quote(join(folder, 'install.ps1'))} ${args}; exit 0 } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }`],
    { encoding: 'utf8' });
  return { code: result.status, out: result.stdout + result.stderr };
}
const installedVersion = async () =>
  JSON.parse((await readFile(join(plugins, 'MyCivil3DMcp.bundle', 'Contents', 'version.json'), 'utf8')).replace(/^﻿/, '')).version;

let central;
try {
  // 0) 시험용 번들: 받은 zip을 풀고 테스트 키로 서명한 뒤, 번들만 담은 zip을 다시 만든다
  const source = join(temporary, 'zip 그대로');
  ps(`Expand-Archive -LiteralPath ${quote(zip)} -DestinationPath ${quote(source)}`);
  await signManifest(join(source, 'MyCivil3DMcp.bundle'));
  const published = join(temporary, 'publish', basename(zip));
  await mkdir(dirname(published), { recursive: true });
  ps(`Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::CreateFromDirectory(${quote(join(source, 'MyCivil3DMcp.bundle'))}, ${quote(published)}, 'Optimal', $true)`);

  // 1) 중앙 서버: 서명 없는 zip, 다른 키로 서명한 zip은 받지 않는다 → (시험이므로) --unsigned 로 넣기 → 배포 지정 → 켜기
  assert.match(cliFails('add', published), /서명\(\.sig\)이 없는 설치본은 받지 않습니다/, 'central refuses an unsigned zip');
  await writeFile(published + '.sig', sign('sha256', await readFile(published), privateKey).toString('base64'));
  assert.match(cliFails('add', published), /서명이 맞지 않습니다/, 'central refuses a zip signed with another key');
  await rm(published + '.sig');
  cli('add', published, '--unsigned');
  cli('publish', version);
  central = spawn(process.execPath, [join(repo, 'central', 'build', 'server.js')], { env: centralEnv, stdio: ['ignore', 'ignore', 'pipe'] });
  let centralOutput = '';
  await new Promise((done, fail) => {
    central.stderr.on('data', chunk => { centralOutput += chunk; if (centralOutput.includes('central server:')) done(); });
    central.on('exit', code => fail(new Error(`central exited ${code}\n${centralOutput}`)));
  });
  const { enrollKey } = JSON.parse(await readFile(join(centralData, 'config.json'), 'utf8'));
  const url = `http://127.0.0.1:${port}`;

  // 2) 설치 파일 폴더: 번들 없이 설치 스크립트, 공개 키, server.json만
  await placeScripts(kit);
  await writeFile(join(kit, 'server.json'), JSON.stringify({ url, enrollKey }));

  const first = install();
  assert.equal(first.code, 0, first.out);
  assert.match(first.out, new RegExp(`최신 버전 ${version.replace(/\./g, '\\.')}을 받고 있습니다`));
  assert.equal(await installedVersion(), version, 'the published version is installed');
  const join_ = JSON.parse(await readFile(join(data, 'central-join.json'), 'utf8'));
  assert.equal(join_.url, url, 'the installer leaves a join request for the service');

  // 3) 다시 실행: 이미 최신
  const again = install();
  assert.equal(again.code, 0, again.out);
  assert.match(again.out, /\[완료\] 이미 같은 버전/);
  assert.doesNotMatch(again.out, /받고 있습니다/, 'an up-to-date PC downloads nothing');

  // 4) 서버가 알려 준 SHA-256과 다른 파일은 설치하지 않는다(설치된 버전은 그대로)
  const releaseJson = join(centralData, 'releases', version, 'release.json');
  const original = await readFile(releaseJson, 'utf8');
  await writeFile(releaseJson, original.replace(/"sha256": "[a-f\d]{64}"/, `"sha256": "${'0'.repeat(64)}"`));
  const tampered = install('-Reinstall');
  assert.notEqual(tampered.code, 0, 'a mismatching download must fail');
  assert.match(tampered.out, /서버의 정보와 다릅니다/);
  assert.equal(await installedVersion(), version, 'a refused download leaves the installed bundle');
  await writeFile(releaseJson, original);

  // 5) 서버가 다른 키로 서명된 번들을 주면(서버 해킹·중간자) 해시가 맞아도 설치하지 않는다
  const otherKit = join(temporary, '다른 키 설치 폴더');
  await mkdir(otherKit);
  await placeScripts(otherKit, (await readFile(join(repo, 'scripts', 'release-public-key.xml'), 'utf8')));   // 실제 릴리스 키를 믿는 설치 파일
  await writeFile(join(otherKit, 'server.json'), JSON.stringify({ url, enrollKey }));
  const forged = installFrom(otherKit, '-Reinstall');
  assert.notEqual(forged.code, 0, 'a bundle signed with another key must fail');
  assert.match(forged.out, /서명이 맞지 않습니다/);
  assert.equal(await installedVersion(), version);

  // 6) 서비스: 가입 요청으로 중앙에 등록하고 요청 파일(가입키)을 지운다
  const joinModule = pathToFileURL(join(repo, 'server', 'build', 'sync', 'installerJoin.js')).href;
  const joined = execFileSync(process.execPath, ['--input-type=module', '-e',
    `const { joinFromInstaller } = await import(${JSON.stringify(joinModule)}); console.log(await joinFromInstaller());`],
    { env: { ...process.env, MY_CIVIL3D_DATA_DIR: data }, encoding: 'utf8' }).trim();
  assert.equal(joined, 'true', 'the service enrolls from the join request');
  const settings = JSON.parse(await readFile(join(data, 'settings.json'), 'utf8'));
  assert.equal(settings.central.url, url);
  assert.match(settings.central.token, /^[a-f\d]{64}$/);
  assert.ok(!existsSync(join(data, 'central-join.json')), 'the enroll key does not stay on disk');

  // 7) 사용자에게 줄 설치 묶음: 배포 zip + server.json
  const kitOut = join(temporary, 'kit');
  cli('kit', kitOut, '--url', url);
  const kitZip = await readFile(join(kitOut, `MyCivil3DMcp-설치-${version}.zip`));
  assert.ok(kitZip.includes(Buffer.from('server.json')), 'the kit carries server.json');

  // 8) server.json 없이 폴더의 번들로 설치(배포 zip을 그대로 푼 경우)도 서명과 버전을 확인한다
  await placeScripts(source);
  await rm(join(source, 'server.json'), { force: true });
  const backups = async () => (await readdir(plugins)).filter(name => name.startsWith('MyCivil3DMcp.bundle.backup-')).length;
  const same = installFrom(source);
  assert.equal(same.code, 0, same.out);
  assert.match(same.out, /\[완료\] 이미 같은 버전/, 'the same version is not installed again');
  assert.doesNotMatch(same.out, /설치 파일을 복사하고 있습니다/);
  // 서명 없는 번들은 설치하지 않는다
  const unsigned = join(temporary, '서명 없음');
  await cp(source, unsigned, { recursive: true });
  await rm(join(unsigned, 'MyCivil3DMcp.bundle', 'Contents', 'manifest.sig'));
  const refusedUnsigned = installFrom(unsigned, '-Reinstall');
  assert.notEqual(refusedUnsigned.code, 0);
  assert.match(refusedUnsigned.out, /서명이 없는 설치 파일입니다/);
  // 끊긴 설치가 남긴 오래된 작업 폴더는 다음 설치 때 지운다
  const stale = join(plugins, '.mycivil3d-stale');
  await mkdir(stale); const old = new Date(Date.now() - 2 * 3600 * 1000); await utimes(stale, old, old);
  const reinstall = installFrom(source, '-Reinstall');
  assert.equal(reinstall.code, 0, reinstall.out);
  assert.match(reinstall.out, /설치했습니다/);
  assert.ok(!existsSync(stale), 'a stale work folder is removed');
  installFrom(source, '-Reinstall');
  assert.equal(await backups(), 1, 'only the latest backup is kept');
  // 더 새 버전이 설치되어 있으면 내려 설치하지 않는다
  const versionFile = join(plugins, 'MyCivil3DMcp.bundle', 'Contents', 'version.json');
  const versionText = await readFile(versionFile, 'utf8');
  await writeFile(versionFile, versionText.replace(/"version":\s*"[^"]+"/, '"version": "99.0.0"'));
  const newer = installFrom(source);
  assert.match(newer.out, /\[완료\] 설치된 버전\(99\.0\.0\)이 이 설치 파일/, 'a newer installed version is kept');
  await writeFile(versionFile, versionText);

  // 9) 서버가 꺼졌고 이 폴더에 설치 파일도 없으면, 이유를 알려 주고 멈춘다
  central.kill(); central = undefined;
  const offline = install('-Reinstall');
  assert.notEqual(offline.code, 0);
  assert.match(offline.out, /서버에서 설치 파일을 받지 못했습니다/);
  assert.equal(await installedVersion(), version, 'nothing changes when the server is down');

  console.log(`Online install passed: publish ${version}, central refuses unsigned and wrongly signed zips, install from server.json only, already up to date, hash mismatch refused, bundle signed with another key refused, service joins central and drops the key, kit carries server.json, local folder install checks signature and version (unsigned refused, same/newer skipped, reinstall), stale work and old backups removed, offline without files explained.`);
} finally {
  central?.kill();
  await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
