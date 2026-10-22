// Civil COM is unavailable in Core Console. Run in a dedicated real Civil profile instead.
import { spawn, execFileSync } from 'node:child_process';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const folder = join(root, '.package-cache', `native-parcel-${Date.now()}`);
const profile = 'MyCivil3DMcpParcelAutomation';
const registry = 'HKCU\\Software\\Autodesk\\AutoCAD\\R25.0\\ACAD-8100:412\\Profiles';
const running = execFileSync('tasklist.exe', ['/FI', 'IMAGENAME eq acad.exe', '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
if (/"acad\.exe"/i.test(running)) throw new Error('Close Civil 3D before the isolated COM test.');
const oldProfile = execFileSync('reg.exe', ['query', registry, '/ve'], { encoding: 'utf8', windowsHide: true })
  .match(/REG_SZ\s+(.+)/)?.[1].trim();
if (!oldProfile) throw new Error('Cannot preserve the current Civil profile.');
await mkdir(folder, { recursive: true });
await copyFile(join(root, 'plugin/bin/Release/net8.0-windows/MyCivil3DMcp.Plugin.dll'), join(folder, 'MyCivil3DMcp.Plugin.dll'));
const harness = join(root, 'tests/CivilCrud.Native/bin/Release/net8.0-windows/CivilCrud.Native.dll');
const template = join(process.env.LOCALAPPDATA, 'Autodesk/C3D 2025/kor/Template/_Autodesk Civil 3D (Metric) NCS.dwt');
const normalized = p => p.replaceAll('\\', '/');
async function run(name, lines, drawing) {
  const script = join(folder, `${name}.scr`);
  await writeFile(script, [...lines, '_.QUIT', '_Yes', ''].join('\r\n'));
  const child = spawn('C:/Program Files/Autodesk/AutoCAD 2025/acad.exe', [
    '/product', 'C3D', '/language', 'ko-KR', '/nologo', '/p', profile,
    ...(drawing ? [drawing] : ['/t', template]), '/b', script
  ], { cwd: folder, windowsHide: true, stdio: 'ignore', env: { ...process.env,
    MY_CIVIL3D_NATIVE_TEST_DIR: folder, MY_CIVIL3D_DATA_DIR: join(folder, 'data'),
    MY_CIVIL3D_CONNECTION_DIR: join(folder, 'connections'), MY_CIVIL3D_SYNC: 'off', MY_CIVIL3D_AUTO_UPDATE: 'off' } });
  const timer = setTimeout(() => spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }), 150000);
  try {
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    if (code !== 0) throw new Error(`${name}: Civil process exited ${code}. Inspect ${folder}.`);
  } finally { clearTimeout(timer); }
}
let creation, reopened;
try {
  // Harness uses an already loaded DLL only if its SHA-256 matches this build; never mix DLLs.
  const prefix = ['(setvar "FILEDIA" 0)', '(setvar "SECURELOAD" 0)',
    '(arxload "C:/Program Files/Autodesk/AutoCAD 2025/C3D/AeccLand.dbx")', '_.NETLOAD', `"${normalized(harness)}"`];
  await run('create', [...prefix, 'MYC3DPARCELAUTOTEST']);
  creation = JSON.parse(await readFile(join(folder, 'parcel-automation.json'), 'utf8'));
  if (creation.failure) throw new Error(creation.failure);
  await run('reopen', [...prefix, 'MYC3DPARCELREOPEN'], join(folder, 'parcel-automation.dwg'));
  reopened = JSON.parse(await readFile(join(folder, 'parcel-reopen.json'), 'utf8'));
  if (reopened.failure) throw new Error(reopened.failure);
  console.log(JSON.stringify({ folder, creation, reopened, manualPalette: 'pending' }));
} finally {
  // Restore the user's next-start profile only AFTER every test process has exited.
  execFileSync('reg.exe', ['add', registry, '/ve', '/t', 'REG_SZ', '/d', oldProfile, '/f'], { windowsHide: true, stdio: 'ignore' });
}
