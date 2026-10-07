// AI CLI discovery and the setup script: setup-ai-cli.ps1 is valid PowerShell and reports
// each CLI on this PC without changing anything, and a CLI installed here is found even
// when the service's PATH is as old as Civil 3D's.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// AI 세션 파일을 실제 사용자 폴더에 쓰지 않는다.
process.env.MY_CIVIL3D_DATA_DIR = mkdtempSync(join(tmpdir(), 'my-civil3d-cli-'));

const { SETUP_SCRIPT } = await import('../build/ai/cliSetup.js');
const errors = execFileSync('powershell.exe', ['-NoProfile', '-Command',
  `$e = $null; [void][System.Management.Automation.Language.Parser]::ParseFile('${SETUP_SCRIPT}', [ref]$null, [ref]$e); $e.Count`], { encoding: 'utf8' }).trim();
assert.equal(errors, '0', 'setup-ai-cli.ps1 has PowerShell syntax errors');
for (const [provider, name] of [['claude', 'Claude'], ['codex', 'Codex'], ['gemini', 'Gemini']]) {
  const status = execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SETUP_SCRIPT, '-Provider', provider, '-Action', 'check'], { encoding: 'utf8' });
  assert.match(status, new RegExp(`${name} CLI: `), status);
}

// Civil 3D started before the CLIs were installed: only Windows folders on PATH.
for (const key of Object.keys(process.env)) if (/^path$/i.test(key)) delete process.env[key];
process.env.Path = String.raw`C:\Windows\system32;C:\Windows`;
const { locateCli } = await import('../build/ai/cliLocator.js');
const found = [];
for (const provider of ['claude', 'codex', 'gemini']) if (await locateCli(provider)) found.push(provider);
console.log(`AI CLI smoke test passed: setup script parses and checks each AI; found with a stale PATH: ${found.join(', ') || 'none installed'}.`);

// Sessions: 30 minutes from the last use; a question starts the time again, an unused AI
// goes back to "unchecked". The clock is moved instead of waited for.
const { verifyProvider, getProviderState, touchProvider, sessionInfo } = await import('../build/ai/aiCli.js');
if (found.includes('codex') && await verifyProvider('codex') === 'ready') {
  const realNow = Date.now;
  let offset = 0;
  Date.now = () => realNow() + offset;
  const minutes = () => Math.round(sessionInfo('codex').expiresInMs / 60000);
  assert.equal(minutes(), 30);
  offset = 20 * 60000;
  assert.equal(minutes(), 10, 'ten minutes left after twenty idle');
  touchProvider('codex');
  assert.equal(minutes(), 30, 'a question starts the time again');
  offset += 29 * 60000;
  assert.equal(await getProviderState('codex'), 'ready');
  offset += 2 * 60000;
  assert.equal(await getProviderState('codex'), 'unchecked', 'unused past the session: released');
  assert.equal(sessionInfo('codex'), undefined);
  touchProvider('codex');
  assert.equal(await getProviderState('codex'), 'unchecked', 'a released session is not revived by use');
  Date.now = realNow;
  console.log('AI session timing passed: 30 min, reset on use, released when idle.');
}
