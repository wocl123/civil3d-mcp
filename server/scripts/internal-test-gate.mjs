import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, copyFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { sourceHash, outputHash, writeReport, checkInternalTest, packageProof, checkPackage } from '../../scripts/internal-test-state.mjs';
const root = await mkdtemp(join(tmpdir(), 'mycivil3d-test-gate-'));
const put = async (name, value) => { await mkdir(resolve(root, name, '..'), { recursive: true }); await writeFile(join(root, name), value); };
try {
  execFileSync('git', ['init', '--quiet', root]);
  await put('server/package.json', JSON.stringify({name:'fixture',version:'0.1.16',dependencies:{example:'1'}}));
  await put('server/package-lock.json', JSON.stringify({version:'0.1.16',packages:{'':{version:'0.1.16',dependencies:{example:'1'}}}}));
  await put('plugin/Entry.cs', 'source');
  await put('plugin/bin/Release/net8.0-windows/MyCivil3DMcp.Plugin.dll', 'compiled');
  await put('server/build/index.js', 'compiled server');
  await assert.rejects(checkInternalTest(root), /기록이 없습니다/);
  const report = {schema:1,automated:'passed',manual:'pending',sourceHash:await sourceHash(root),outputHash:await outputHash(root)};
  await writeReport(report, root);
  await assert.rejects(checkInternalTest(root), /수동 테스트가 미완료/);
  await checkInternalTest(root, false);
  await writeReport({...report,manual:'passed'}, root);
  await checkInternalTest(root);
  // Release metadata can change after acceptance, while dependencies cannot.
  const json = JSON.parse(await readFile(join(root,'server/package.json')));
  json.version='0.1.17'; await put('server/package.json',JSON.stringify(json));
  const lock = JSON.parse(await readFile(join(root,'server/package-lock.json')));
  lock.version=lock.packages[''].version='0.1.17'; await put('server/package-lock.json',JSON.stringify(lock));
  await checkInternalTest(root);
  json.dependencies.example='2'; await put('server/package.json',JSON.stringify(json));
  await assert.rejects(checkInternalTest(root), /변경/);
  json.dependencies.example='1'; await put('server/package.json',JSON.stringify(json));
  await put('plugin/Entry.cs','modified source');
  await assert.rejects(checkInternalTest(root), /변경/);
  await put('plugin/Entry.cs','source');
  await put('server/build/index.js','modified binary');
  await assert.rejects(checkInternalTest(root), /변경/);
  await put('server/build/index.js','compiled server');
  await put('dist/MyCivil3DMcp-0.1.17-win-x64.exe','tested installer');
  await assert.rejects(checkPackage(root), /배포 파일 기록이 없습니다/);
  await writeReport({...report,manual:'passed',packaged:await packageProof(root)},root);
  await checkPackage(root);
  await put('dist/MyCivil3DMcp-0.1.17-win-x64.exe','different installer');
  await assert.rejects(checkPackage(root), /배포 파일 기록이 없습니다/);
  await writeReport({...report,automated:'running',manual:'passed'}, root);
  await assert.rejects(checkInternalTest(root), /자동 테스트가 완료되지/);
  // Execute the real deployment entry point: a missing/pending acceptance cannot reach version/config mutations.
  await put('.drive-deploy.json','{"version":"0.1.16"}');
  for (const name of ['deploy.ps1','package-common.ps1','internal-test-state.mjs']) {
    await mkdir(join(root,'scripts'),{recursive:true});
    await copyFile(new URL('../../scripts/'+name,import.meta.url),join(root,'scripts',name));
  }
  const before = await readFile(join(root,'server/package.json'),'utf8');
  assert.throws(() => execFileSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',join(root,'scripts/deploy.ps1'),'-Version','0.1.17'],
    {encoding:'utf8',stdio:'pipe'}), error => /내부 테스트/.test(error.stderr));
  assert.equal(await readFile(join(root,'server/package.json'),'utf8'),before);
  assert.equal(await readFile(join(root,'.drive-deploy.json'),'utf8'),'{"version":"0.1.16"}');
  console.log('Internal test gate passed: missing/pending/changed source or binaries block deployment before version/config writes; version-only promotion is allowed.');
} finally {
  if (!resolve(root).startsWith(join(resolve(tmpdir()), 'mycivil3d-test-gate-'))) throw Error('Unsafe test cleanup');
  await rm(root,{recursive:true,force:true});
}
