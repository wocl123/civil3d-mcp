// 온라인 설치를 실제 설치 zip으로 끝까지 해 본다(package.ps1이 zip을 만든 뒤 실행).
//   node scripts/online-install.mjs <MyCivil3DMcp-x.y.z-win-x64.zip>
// 중앙 서버에 zip을 넣고 배포 지정 → 설치 파일만 있는 폴더(server.json + install.ps1)로 설치 →
// 다시 실행하면 "이미 최신" → 서버 정보와 다른 파일은 거절 → 서비스가 가입 요청으로 중앙에 등록 →
// 서버가 꺼졌고 설치 파일도 없으면 안내 → 사용자에게 줄 설치 묶음(kit)에 server.json이 들어감.
// 설치 대상과 데이터는 모두 임시 폴더다.
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
const port = 49600 + Math.floor(Math.random() * 300);
const centralEnv = { ...process.env, CENTRAL_DATA_DIR: centralData, CENTRAL_PORT: String(port) };
const releaseCli = join(repo, 'central', 'build', 'release.js');
const cli = (...args) => execFileSync(process.execPath, [releaseCli, ...args], { env: centralEnv, encoding: 'utf8' });

// install.ps1을 설치 파일 폴더에서 실행한다. 한글 출력을 UTF-8로 받는다.
function install(...extra) {
  const script = join(kit, 'install.ps1').replace(/'/g, "''");
  const args = [`-DestinationRoot '${plugins.replace(/'/g, "''")}'`, `-DataDir '${data.replace(/'/g, "''")}'`, '-SkipRunningCheck', ...extra].join(' ');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
    `[Console]::OutputEncoding=[Text.Encoding]::UTF8; try { & '${script}' ${args}; exit 0 } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }`],
    { encoding: 'utf8' });
  return { code: result.status, out: result.stdout + result.stderr };
}
const installedVersion = async () =>
  JSON.parse((await readFile(join(plugins, 'MyCivil3DMcp.bundle', 'Contents', 'version.json'), 'utf8')).replace(/^﻿/, '')).version;

let central;
try {
  // 1) 중앙 서버: 넣기 → 배포 지정 → 켜기
  cli('add', zip);
  cli('publish', version);
  central = spawn(process.execPath, [join(repo, 'central', 'build', 'server.js')], { env: centralEnv, stdio: ['ignore', 'ignore', 'pipe'] });
  await new Promise((done, fail) => {
    central.stderr.on('data', chunk => { if (String(chunk).includes('central server:')) done(); });
    central.on('exit', code => fail(new Error(`central exited ${code}`)));
  });
  const { enrollKey } = JSON.parse(await readFile(join(centralData, 'config.json'), 'utf8'));
  const url = `http://127.0.0.1:${port}`;

  // 2) 설치 파일 폴더: 번들 없이 설치 스크립트와 server.json만
  for (const name of ['install.ps1', 'package-common.ps1']) await copyFile(join(repo, 'scripts', name), join(kit, name));
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
  assert.match(again.out, /이미 최신 버전입니다/);

  // 4) 서버가 알려 준 SHA-256과 다른 파일은 설치하지 않는다(설치된 버전은 그대로)
  const releaseJson = join(centralData, 'releases', version, 'release.json');
  const original = await readFile(releaseJson, 'utf8');
  await writeFile(releaseJson, original.replace(/"sha256": "[a-f\d]{64}"/, `"sha256": "${'0'.repeat(64)}"`));
  const tampered = install('-Reinstall');
  assert.notEqual(tampered.code, 0, 'a mismatching download must fail');
  assert.match(tampered.out, /서버의 정보와 다릅니다/);
  assert.equal(await installedVersion(), version, 'a refused download leaves the installed bundle');
  await writeFile(releaseJson, original);

  // 5) 서비스: 가입 요청으로 중앙에 등록하고 요청 파일(가입키)을 지운다
  const joinModule = pathToFileURL(join(repo, 'server', 'build', 'sync', 'installerJoin.js')).href;
  const joined = execFileSync(process.execPath, ['--input-type=module', '-e',
    `const { joinFromInstaller } = await import(${JSON.stringify(joinModule)}); console.log(await joinFromInstaller());`],
    { env: { ...process.env, MY_CIVIL3D_DATA_DIR: data }, encoding: 'utf8' }).trim();
  assert.equal(joined, 'true', 'the service enrolls from the join request');
  const settings = JSON.parse(await readFile(join(data, 'settings.json'), 'utf8'));
  assert.equal(settings.central.url, url);
  assert.match(settings.central.token, /^[a-f\d]{64}$/);
  assert.ok(!existsSync(join(data, 'central-join.json')), 'the enroll key does not stay on disk');

  // 6) 사용자에게 줄 설치 묶음: 배포 zip + server.json
  const kitOut = join(temporary, 'kit');
  cli('kit', kitOut, '--url', url);
  const kitZip = await readFile(join(kitOut, `MyCivil3DMcp-설치-${version}.zip`));
  assert.ok(kitZip.includes(Buffer.from('server.json')), 'the kit carries server.json');

  // 7) 서버가 꺼졌고 이 폴더에 설치 파일도 없으면, 이유를 알려 주고 멈춘다
  central.kill(); central = undefined;
  const offline = install('-Reinstall');
  assert.notEqual(offline.code, 0);
  assert.match(offline.out, /서버에서 설치 파일을 받지 못했습니다/);
  assert.equal(await installedVersion(), version, 'nothing changes when the server is down');

  console.log(`Online install passed: publish ${version}, install from server.json only, already up to date, hash mismatch refused, service joins central and drops the key, kit carries server.json, offline without files explained.`);
} finally {
  central?.kill();
  await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
