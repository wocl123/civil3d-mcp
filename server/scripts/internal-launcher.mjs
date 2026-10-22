// Exercise the BAT itself: PowerShell-only checks miss CMD encoding and line-ending failures.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

if (process.platform === 'win32') {
  const temporary = await mkdtemp(join(tmpdir(), 'mycivil3d-internal-launch-'));
  try {
    const folder = join(temporary, '한글 공백 경로');
    await mkdir(join(folder, 'scripts'), { recursive: true });
    for (const [name, script, failure] of [
      ['내부테스트.bat', 'internal-test.ps1', '내부 테스트 미완료'],
      ['내부배포.bat', 'internal-deploy.ps1', '내부 배포 실패']
    ]) {
    const bytes = await readFile(new URL('../../' + name, import.meta.url));
    const body = bytes.toString('utf8');
    assert.ok(!body.startsWith('\uFEFF'), 'CMD launcher must not have a UTF-8 BOM');
    assert.doesNotMatch(body, /(?<!\r)\n/, 'CMD launcher must use CRLF');
    const launcher = join(folder, name);
    await writeFile(launcher, bytes);
    // Only the target script is a fixture: never run tests, accept manual testing, or publish here.
    await writeFile(join(folder, 'scripts', script), '\uFEFFparam([int]$ResultCode=0)\r\n' +
      'Write-Output "LAUNCH_OK"\r\nWrite-Output ("CWD:" + (Get-Location).Path)\r\nexit $ResultCode\r\n');
    for (const code of [0, 7]) {
      const result = spawnSync(join(process.env.SystemRoot, 'System32/cmd.exe'),
        ['/d', '/s', '/c', `""${launcher}" -ResultCode ${code}"`], {
          windowsVerbatimArguments: true, windowsHide: true, cwd: temporary,
          input: '\r\n', encoding: 'utf8', timeout: 15000
        });
      assert.ifError(result.error);
      const output = result.stdout + result.stderr;
      assert.equal(result.status, code, output);
      assert.match(output, /LAUNCH_OK/);
      assert.ok(output.includes('CWD:' + folder), output);
      assert.doesNotMatch(output, /not recognized|xecutionPolicy|내부 또는 외부 명령/);
      if (code) assert.ok(output.includes(failure), output);
      else assert.ok(!output.includes(failure), output);
    }
    }
    console.log('Internal BAT passed: actual CMD parsing, CRLF, Korean/space paths, unrelated working directory, arguments and preserved failure exit code.');
  } finally {
    if (!resolve(temporary).startsWith(join(resolve(tmpdir()), 'mycivil3d-internal-launch-'))) throw Error('Unsafe cleanup');
    await rm(temporary, { recursive: true, force: true });
  }
}
