// 임시 프로필의 시험 도면으로 실행한다. --persisted는 저장한 DWG를 새 프로세스에서 다시 연다.
import { spawn } from 'node:child_process';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';

const root = fileURLToPath(new URL('../..', import.meta.url));
const persisted = process.argv.includes('--persisted');
const networks = process.argv.includes('--networks');
const folder = join(root, '.package-cache', `native-crud-${Date.now()}`);
await mkdir(folder, { recursive: true });
await copyFile(join(root, 'plugin/bin/Release/net8.0-windows/MyCivil3DMcp.Plugin.dll'),
  join(folder, 'MyCivil3DMcp.Plugin.dll'));
const module = resolve(root, 'tests/CivilCrud.Native/bin/Release/net8.0-windows/CivilCrud.Native.dll').replaceAll('\\', '/');
async function runNative(command, drawing) {
  const script = join(folder, `${command}.scr`);
  await writeFile(script, [
    'FILEDIA', '0', 'SECURELOAD', '0',
    '(arxload "C:/Program Files/Autodesk/AutoCAD 2025/C3D/AeccLand.dbx")',
    '(arxload "C:/Program Files/Autodesk/AutoCAD 2025/C3D/AeccPressurePipes.dbx")',
    '_.NETLOAD', `"${module}"`, command, '_.QUIT', '_Yes', ''
  ].join('\r\n'));
  const child = spawn('C:/Program Files/Autodesk/AutoCAD 2025/accoreconsole.exe',
    ['/isolate', 'CivilCrudTest', join(folder, 'profile'), ...(drawing ? ['/i', drawing] : []),
      '/s', script, '/l', 'en-US'], {
      cwd: folder, windowsHide: true, env: { ...process.env, MY_CIVIL3D_NATIVE_TEST_DIR: folder,
        MY_CIVIL3D_DATA_DIR: join(folder, 'data') },
      stdio: ['ignore', 'pipe', 'pipe']
    });
  const chunks = [];
  child.stdout.on('data', chunk => chunks.push(chunk));
  child.stderr.on('data', chunk => chunks.push(chunk));
  const timer = setTimeout(() => {
    spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  }, 90000);
  const code = await new Promise((done, reject) => { child.once('close', done); child.once('error', reject); });
  clearTimeout(timer);
  await writeFile(join(folder, `${command}.log`), Buffer.concat(chunks));
  return code;
}
if (persisted) {
  const prepared = await runNative('MYC3DCRUDPREPARE');
  if (prepared !== 0) throw new Error(`Fixture preparation failed: ${folder}`);
  await readFile(join(folder, 'prepared.json'), 'utf8');
}
if (networks) {
  await copyFile('C:/Program Files/Autodesk/AutoCAD 2025/C3D/Help/Civil Tutorials/Drawings/Pipe Networks-3C.dwg',
    join(folder, 'networks.dwg'));
}
const code = await runNative(networks ? 'MYC3DNETWORKTEST' : persisted ? 'MYC3DCRUDPERSISTTEST' : 'MYC3DCRUDTEST',
  networks ? join(folder, 'networks.dwg') : persisted ? join(folder, 'fixture.dwg') : undefined);
let result = await readFile(join(folder, 'result.json'), 'utf8').then(JSON.parse).catch(() => undefined);
let reopenCode;
if (networks && code === 0 && result && !result.failure) {
  reopenCode = await runNative('MYC3DNETWORKREOPENTEST', join(folder, 'networks-edited.dwg'));
  result = await readFile(join(folder, 'result.json'), 'utf8').then(JSON.parse).catch(() => undefined);
}
if (!networks && !persisted && code === 0 && result && !result.failure) {
  reopenCode = await runNative('MYC3DEXTENSIONREOPENTEST', join(folder, 'extensions.dwg'));
  result = await readFile(join(folder, 'result.json'), 'utf8').then(JSON.parse).catch(() => undefined);
}
console.log(JSON.stringify({ folder, code, reopenCode, result: result ?? 'No native result; inspect MYC3D*.log.' }));
if (code !== 0 || (reopenCode !== undefined && reopenCode !== 0) || !result || result.failure) process.exitCode = 1;
