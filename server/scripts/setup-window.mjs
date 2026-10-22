// Exercise the actual Windows launcher and console handshake without installing or signing in.
import assert from 'node:assert/strict';
import { mkdtemp, rm, copyFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startSetupProcess } from '../build/ai/setupProcess.js';
import { SETUP_SCRIPT } from '../build/ai/cliSetup.js';

const temporary = await mkdtemp(join(tmpdir(), 'mycivil3d-setup-test-'));
const script = join(temporary, "한글 경로 ' setup.ps1");
const env = { ...process.env, MY_CIVIL3D_CLI_DIRS: temporary };
delete env.MY_CIVIL3D_NODE_EXE;
delete env.MY_CIVIL3D_CLI_PREFIX;
for (const key of Object.keys(env)) if (/^path$/i.test(key)) delete env[key];
env.Path = join(process.env.SystemRoot, 'System32');
env.MY_CIVIL3D_CLI_ROOT = join(temporary, 'empty-cli');

try {
  await copyFile(SETUP_SCRIPT, script);
  for (const provider of ['claude', 'codex', 'gemini']) {
    const window = await startSetupProcess(script, provider, 'check', env);
    await window.closed;
  }

  await assert.rejects(startSetupProcess(join(temporary, 'missing.ps1'), 'gemini', 'check', env),
    /시작되지 않았습니다/, 'a failed PowerShell launch must not report success');
  const rejected = join(temporary, 'reject.ps1');
  await writeFile(rejected, '\ufeffparam($Provider, $Action)\n' +
    '@{ready=$false; message="console rejected"} | ConvertTo-Json | ' +
    'Set-Content -LiteralPath $env:MY_CIVIL3D_SETUP_STATUS -Encoding UTF8\n');
  await assert.rejects(startSetupProcess(rejected, 'gemini', 'check', env), /console rejected/);
  console.log('Setup window passed: three missing CLIs, interactive console, Korean/quote paths, launch failure, rejected console.');
} finally {
  await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
