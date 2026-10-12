// 실제 설치 EXE(Inno Setup)를 임시 폴더에서 시험한다: 창 없는 설치, 번들 검증, 팀 정보, 제거,
// 예전 자동 업데이트 호출(--extract) 거절, 서명 확인 후 업데이트, 변조된 EXE 거절.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, mkdtemp, mkdir, copyFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { sandboxInstall } from '../../scripts/installer-sandbox.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const exe = resolve(process.argv[2]);
const temp = await mkdtemp(join(tmpdir(), 'mycivil3d-exe-test-'));
const quote = text => "'" + text.replace(/'/g, "''") + "'";
const readJson = async file => JSON.parse((await readFile(file, 'utf8')).replace(/^\s+/, ''));

function powershell(command) {
  const script = '[Console]::OutputEncoding=[Text.Encoding]::UTF8; '
    + 'try { ' + command + '; exit 0 } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }';
  return spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], { encoding: 'utf8', windowsHide: true });
}

// 번들 안의 파일이 manifest 목록과 정확히 같은지(빠진 파일, 남은 파일, 내용).
function assertBundleMatchesManifest(bundle) {
  const check = powershell('. ' + quote(join(repo, 'scripts', 'package-common.ps1')) + '; [void](Test-Bundle ' + quote(bundle) + ')');
  assert.equal(check.status, 0, check.stdout + check.stderr);
}

// 제거 프로그램은 자기 사본을 임시 폴더에 띄우고 바로 끝난다. 폴더가 사라질 때까지 기다린다.
async function waitUntilRemoved(path) {
  for (let i = 0; i < 120 && existsSync(path); i++) {
    await delay(500);
  }

  assert.ok(!existsSync(path), `제거 후에도 남아 있음: ${path}`);
}

try {
  // 1. 창 없는 설치
  const sandbox = sandboxInstall(exe, join(temp, '시험 설치'));
  const version = (await readJson(join(sandbox.bundle, 'Contents', 'version.json'))).version;
  assert.equal(basename(exe), `MyCivil3DMcp-${version}-win-x64.exe`);
  assertBundleMatchesManifest(sandbox.bundle);
  if (sandbox.team) {
    assert.match(sandbox.team.adminEmail, /@/);
  }

  // 2. 같은 버전 위에 다시 설치: 이전 파일이 남지 않는다.
  const stale = join(sandbox.bundle, 'Contents', 'server', 'build', 'stale-from-old-version.js');
  await writeFile(stale, '// old');
  sandboxInstall(exe, join(temp, '시험 설치'));
  assert.ok(!existsSync(stale), 'reinstall removes files that are no longer shipped');
  assertBundleMatchesManifest(sandbox.bundle);

  // 3. 제거: 번들은 지우고 사용자 데이터(team.json)는 남긴다.
  assert.ok(existsSync(sandbox.uninstaller), 'uninstaller is outside the bundle');
  const uninstall = spawnSync(sandbox.uninstaller, ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART'], { windowsHide: true });
  assert.equal(uninstall.status, 0);
  await waitUntilRemoved(sandbox.bundle);
  if (sandbox.team) {
    assert.ok(existsSync(join(sandbox.data, 'team.json')), 'uninstall keeps user data');
  }

  // 4. 0.1.7 이하의 자동 업데이트는 --extract로 부른다: 마법사를 열지 않고 바로 실패해야 한다.
  const legacy = spawnSync(exe, ['--extract', join(temp, 'legacy')], { windowsHide: true, timeout: 60000 });
  assert.equal(legacy.error, undefined, 'legacy call ends without opening the wizard');
  assert.notEqual(legacy.status, 0, 'legacy --extract call is refused');
  assert.ok(!existsSync(join(temp, 'legacy')));

  // 5. 자동 업데이트: 서명을 확인한 뒤 설치한다. 서명이 맞지 않으면 실행하지 않는다.
  if (existsSync(exe + '.sig')) {
    const helper = join(temp, 'trusted');
    await mkdir(helper);
    for (const name of ['release-public-key.xml', 'install-exe.ps1']) {
      await copyFile(join(repo, 'scripts', name), join(helper, name));
    }

    const plugins = join(temp, 'update', 'plugins');
    const data = join(temp, 'update', 'data');
    const archive = join(temp, 'download.exe');
    const bytes = await readFile(exe);
    await writeFile(archive, bytes);
    const metadata = {
      size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      signature: (await readFile(exe + '.sig', 'ascii')).trim()
    };
    await writeFile(archive + '.json', JSON.stringify(metadata));

    const invoke = '& ' + quote(join(helper, 'install-exe.ps1')) + ' -Archive ' + quote(archive)
      + ' -DataDir ' + quote(data) + ' -DestinationRoot ' + quote(plugins) + ' -SkipRunningCheck';
    const update = powershell(invoke);
    assert.equal(update.status, 0, update.stdout + update.stderr);
    assertBundleMatchesManifest(join(plugins, 'MyCivil3DMcp.bundle'));

    // 해시는 변조된 바이트와 맞춰도, 서명이 맞지 않으면 실행 전에 거절한다.
    const tampered = Buffer.from(bytes);
    tampered[tampered.length - 1] ^= 1;
    await writeFile(archive, tampered);
    metadata.sha256 = createHash('sha256').update(tampered).digest('hex');
    await writeFile(archive + '.json', JSON.stringify(metadata));
    const refused = powershell(invoke);
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /signature mismatch/);
  }

  console.log('installer exe ok: silent install, manifest match, clean reinstall, uninstall, legacy call refused, trusted update, tampered EXE refused');
} finally {
  await rm(temp, { recursive: true, force: true });
}
