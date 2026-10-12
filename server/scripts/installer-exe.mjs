// Real EXE extraction + existing installer + trusted EXE update helper, all into temporary folders.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, mkdtemp, mkdir, copyFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const exe = resolve(process.argv[2]);
const temp = await mkdtemp(join(tmpdir(), 'mycivil3d-exe-test-'));
const q = s => "'" + s.replace(/'/g, "''") + "'";
const ps = command => spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
  '[Console]::OutputEncoding=[Text.Encoding]::UTF8; try { ' + command + '; exit 0 } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }'],
  { encoding: 'utf8', windowsHide: true });
try {
  const extracted = join(temp, '압축 해제');
  const result = spawnSync(exe, ['--extract', extracted], { windowsHide: true });
  assert.equal(result.status, 0);
  assert.ok(existsSync(join(extracted, 'MyCivil3DMcp.bundle.zip')));
  assert.equal(spawnSync(exe, ['--extract', extracted], { windowsHide: true }).status, 1, 'existing extraction directory is refused');
  const signed = existsSync(exe + '.sig');
  const plugins = join(temp, 'plugins'), data = join(temp, 'data');
  const first = ps('& ' + q(join(extracted, 'install.ps1')) + ' -DestinationRoot ' + q(plugins) + ' -DataDir ' + q(data) + ' -SkipRunningCheck' + (signed ? '' : ' -AllowUnsigned'));
  assert.equal(first.status, 0, first.stdout + first.stderr);
  const installed = join(plugins, 'MyCivil3DMcp.bundle');
  const version = JSON.parse((await readFile(join(installed, 'Contents', 'version.json'), 'utf8')).replace(/^\uFEFF/, '')).version;
  assert.equal(basename(exe), `MyCivil3DMcp-${version}-win-x64.exe`);
  const teamFile = join(extracted, 'team.json');
  if (existsSync(teamFile)) {
    const expected = JSON.parse((await readFile(teamFile, 'utf8')).replace(/^\uFEFF/, ''));
    const actual = JSON.parse(await readFile(join(data, 'team.json'), 'utf8'));
    assert.equal(actual.adminEmail, expected.adminEmail);
    if (expected.releaseManifestId) assert.equal(actual.releaseManifestId, expected.releaseManifestId);
    if (expected.githubRepo) assert.equal(actual.githubRepo, expected.githubRepo);
    if (expected.ingestUrl) assert.equal(actual.ingestUrl, expected.ingestUrl);
  }
  if (signed) {
    const helper = join(temp, 'trusted');
    await mkdir(helper);
    for (const name of ['install.ps1', 'package-common.ps1', 'release-public-key.xml', 'install-exe.ps1'])
      await copyFile(join(repo, 'scripts', name), join(helper, name));
    const archive = join(temp, 'download.exe'), bytes = await readFile(exe);
    await writeFile(archive, bytes);
    const metadata = { size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), signature: (await readFile(exe + '.sig', 'ascii')).trim() };
    await writeFile(archive + '.json', JSON.stringify(metadata));
    const invoke = '& ' + q(join(helper, 'install-exe.ps1')) + ' -Archive ' + q(archive) + ' -DataDir ' + q(data) + ' -DestinationRoot ' + q(plugins) + ' -SkipRunningCheck';
    const update = ps(invoke);
    assert.equal(update.status, 0, update.stdout + update.stderr);
    // Hash can match tampered bytes, but trusted signature must still reject before launching.
    const tampered = Buffer.from(bytes); tampered[tampered.length - 1] ^= 1;
    await writeFile(archive, tampered);
    metadata.sha256 = createHash('sha256').update(tampered).digest('hex');
    await writeFile(archive + '.json', JSON.stringify(metadata));
    const refused = ps(invoke);
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /signature mismatch/);
  }
  console.log('installer exe ok: extraction, initial install, team channel, trusted update, tampered EXE refused');
} finally { await rm(temp, { recursive: true, force: true }); }
