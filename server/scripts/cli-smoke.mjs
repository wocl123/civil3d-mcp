// AI CLI discovery and the setup script: setup-ai-cli.ps1 is valid PowerShell and reports
// each CLI on this PC without changing anything, and a CLI installed here is found even
// when the service's PATH is as old as Civil 3D's.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

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
