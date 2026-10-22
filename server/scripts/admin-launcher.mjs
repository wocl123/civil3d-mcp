import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, access } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

if (process.platform === 'win32') {
  const temporary = await mkdtemp(join(tmpdir(), 'mycivil3d-admin-launch-'));
  try {
    const bundleNode = join(process.env.APPDATA, 'Autodesk/ApplicationPlugins/MyCivil3DMcp.bundle/Contents/node/node.exe');
    const hasBundle = await access(bundleNode).then(() => true, () => false);
    const env = { ...process.env, MY_CIVIL3D_DATA_DIR: join(temporary, 'data'), MY_CIVIL3D_SYNC: 'off' };
    for (const key of Object.keys(env)) if (/^path$/i.test(key)) delete env[key];
    env.Path = [hasBundle ? undefined : dirname(process.execPath), join(process.env.SystemRoot, 'System32')].filter(Boolean).join(';');
    const launcher = resolve('../관리자실행.bat');
    const cmd = join(process.env.SystemRoot, 'System32/cmd.exe');
    const launch = () => spawnSync(cmd, ['/d', '/s', '/c', `""${launcher}""`], {
      windowsVerbatimArguments: true, windowsHide: true, input: '0\r\n', encoding: 'utf8', timeout: 20000, env
    });
    const first = launch();
    const output = first.stdout + first.stderr;
    if (first.status !== 0 && output.includes('관리자 프로그램이 이미 실행 중입니다')) {
      console.log('Admin BAT launch skipped: an existing administrator window owns the mutex.');
    } else {
      assert.equal(first.status, 0, output);
      assert.match(first.stdout, /메인 메뉴/);
      const second = launch();
      assert.equal(second.status, 0, second.stdout + second.stderr);
      assert.doesNotMatch(second.stdout, /변경된 관리자 프로그램을 빌드/);
      assert.doesNotMatch(second.stdout, /아무 키|press any key/i, 'normal exit must not require an extra key');
      console.log(`Admin BAT passed: clean exit, cached build${hasBundle ? ', bundled Node with no system Node/npm on PATH' : ''}.`);
    }
  } finally {
    await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}
