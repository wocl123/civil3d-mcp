// Internal acceptance belongs to the exact source and compiled DLL/server, never just a version number.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = resolve(fileURLToPath(new URL('..', import.meta.url)));
export const reportFile = root => join(root, '.package-cache/internal-test/report.json');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

export async function sourceHash(root = repository) {
  const listed = execFileSync('git', ['-c', 'core.quotepath=false', 'ls-files', '-z', '--cached', '--others', '--exclude-standard',
    '--', 'plugin', 'server', 'scripts', 'tests', 'docs', '.github', 'README.md', 'AGENTS.md', '.editorconfig', '내부테스트.bat', '내부배포.bat', '배포하기.bat'], { cwd: root, encoding: 'utf8' });
  const files = [...new Set(listed.split('\0').filter(Boolean))].sort();
  const records = [];
  for (const file of files) {
    let bytes;
    try { bytes = await readFile(join(root, file)); }
    catch (error) { if (error.code === 'ENOENT') { records.push(`${file}:deleted`); continue; } throw error; }
    // A release number is assigned only after acceptance. Dependency/script changes still invalidate it.
    if (file === 'server/package.json' || file === 'server/package-lock.json') {
      const json = JSON.parse(bytes);
      delete json.version;
      if (json.packages?.['']) delete json.packages[''].version;
      bytes = Buffer.from(JSON.stringify(json));
    }
    records.push(`${file}:${sha(bytes)}`);
  }
  if (!records.length) throw Error('내부 테스트 소스를 찾지 못했습니다.');
  return sha(records.join('\n'));
}

async function filesUnder(folder) {
  const files = [];
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw Error('내부 테스트 산출물에 링크가 있습니다.');
    const path = join(folder, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

export async function outputHash(root = repository) {
  const plugin = join(root, 'plugin/bin/Release/net8.0-windows/MyCivil3DMcp.Plugin.dll');
  const files = [plugin, ...await filesUnder(join(root, 'server/build'))].sort();
  return sha((await Promise.all(files.map(async file => `${relative(root, file).replaceAll('\\', '/')}:${sha(await readFile(file))}`))).join('\n'));
}

export async function readReport(root = repository) {
  try { return JSON.parse(await readFile(reportFile(root), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') throw Error('내부 테스트 기록이 없습니다. 먼저 내부테스트.bat을 실행하세요.'); throw error; }
}

export async function checkInternalTest(root = repository, requireManual = true) {
  const report = await readReport(root);
  if (report.schema !== 1 || report.automated !== 'passed') throw Error('내부 자동 테스트가 완료되지 않았습니다. 내부테스트.bat을 다시 실행하세요.');
  if (report.sourceHash !== await sourceHash(root) || report.outputHash !== await outputHash(root)) {
    throw Error('내부 테스트 후 소스 또는 DLL/서버가 변경됐습니다. 내부테스트.bat을 다시 실행하세요.');
  }
  if (requireManual && report.manual !== 'passed') throw Error('Civil 3D 수동 테스트가 미완료입니다. 기능 확인 후 내부테스트.bat -ConfirmManualPass로 기록하세요.');
  return report;
}

export async function writeReport(report, root = repository) {
  await mkdir(join(root, '.package-cache/internal-test'), { recursive: true });
  await writeFile(reportFile(root), JSON.stringify(report, null, 2) + '\n');
}

export async function packageProof(root = repository) {
  const { version } = JSON.parse(await readFile(join(root, 'server/package.json'), 'utf8'));
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw Error('배포 버전 형식 오류');
  const file = join(root, 'dist', `MyCivil3DMcp-${version}-win-x64.exe`);
  return { version, sha256: sha(await readFile(file)) };
}

export async function checkPackage(root = repository) {
  const report = await checkInternalTest(root);
  const proof = await packageProof(root);
  if (report.packaged?.version !== proof.version || report.packaged?.sha256 !== proof.sha256) {
    throw Error('현재 내부 테스트 수정본으로 만든 배포 파일 기록이 없습니다. -SkipBuild 없이 다시 패키징하세요.');
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const action = process.argv[2];
  if (action === 'begin') {
    await writeReport({ schema: 1, automated: 'running', manual: 'pending', startedAt: new Date().toISOString(), sourceHash: await sourceHash() });
  } else if (action === 'pass') {
    const report = await readReport();
    if (report.automated !== 'running' || report.sourceHash !== await sourceHash()) throw Error('테스트 실행 중 소스가 바뀌었습니다. 다시 실행하세요.');
    await writeReport({ ...report, automated: 'passed', testedAt: new Date().toISOString(), outputHash: await outputHash() });
    console.log('내부 자동 테스트 통과. Civil 3D 수동 기능 확인이 남았습니다.');
  } else if (action === 'approve') {
    const report = await checkInternalTest(repository, false);
    await writeReport({ ...report, manual: 'passed', acceptedAt: new Date().toISOString() });
    console.log('현재 소스와 DLL/서버의 내부 테스트 완료를 기록했습니다. 배포 버전은 변경하지 않았습니다.');
  } else if (action === 'check') {
    await checkInternalTest();
    console.log('현재 소스와 DLL/서버의 내부 테스트 완료 기록을 확인했습니다.');
  } else if (action === 'record-package') {
    const report = await checkInternalTest();
    await writeReport({ ...report, packaged: await packageProof() });
  } else if (action === 'check-package') {
    await checkPackage();
  } else throw Error('사용법: node scripts/internal-test-state.mjs begin|pass|approve|check|record-package|check-package');
}
