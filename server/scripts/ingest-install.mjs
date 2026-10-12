// Verify the actual installed team-setting copier without installing into the live user profile.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
const temp = mkdtempSync(join(tmpdir(), 'mycivil3d-ingest-install-'));
const endpoint = 'https://script.google.com/macros/s/TEST_AUTOMATIC_INGEST_DEPLOYMENT_123456/exec';
const team = join(temp, 'team.json'), data = join(temp, 'data');
const quote = x => "'" + x.replace(/'/g, "''") + "'";
const invoke = () => spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
  "$ErrorActionPreference='Stop'; Set-StrictMode -Version Latest; . " + quote(resolve('../scripts/package-common.ps1')) + '; Save-TeamInfo ' + quote(team) + ' ' + quote(data)],
  { encoding: 'utf8', windowsHide: true });
try {
  writeFileSync(team, JSON.stringify({ adminEmail: 'test@example.com', releaseManifestId: 'MANIFEST_ID_TEST_12345', githubRepo: 'test/distribution', ingestUrl: endpoint }));
  const first = invoke();
  assert.equal(first.status, 0, first.stderr);
  assert.equal(JSON.parse(readFileSync(join(data, 'team.json'), 'utf8')).ingestUrl, endpoint);
  assert.equal(JSON.parse(readFileSync(join(data, 'team.json'), 'utf8')).githubRepo, 'test/distribution');
  assert.ok(!first.stdout.includes('공유하세요'));
  // Updating team info preserves the new automatic channel and does not touch existing user logs.
  writeFileSync(join(data, 'user-log.txt'), 'keep');
  assert.equal(invoke().status, 0);
  assert.equal(readFileSync(join(data, 'user-log.txt'), 'utf8'), 'keep');
  const before = readFileSync(join(data, 'team.json'), 'utf8');
  writeFileSync(team, JSON.stringify({ adminEmail: 'test@example.com', ingestUrl: endpoint.replace('google.com', 'google.com.evil.test') }));
  assert.notEqual(invoke().status, 0);
  assert.equal(readFileSync(join(data, 'team.json'), 'utf8'), before);
  assert.ok(existsSync(join(data, 'user-log.txt')));
  writeFileSync(team, JSON.stringify({ adminEmail: 'test@example.com' }));
  const legacy = invoke(); assert.equal(legacy.status, 0, legacy.stderr);
  assert.equal(JSON.parse(readFileSync(join(data, 'team.json'), 'utf8')).adminEmail, 'test@example.com');
  console.log('ingest install ok: initial team save, update data preservation, invalid endpoint refused');
} finally { rmSync(temp, { recursive: true, force: true }); }
