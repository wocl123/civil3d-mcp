// NETLOAD the actual production DLL in Autodesk's engine and verify Initialize + the development Node service.
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
const root = fileURLToPath(new URL('../..', import.meta.url));
const folder = join(root, '.package-cache', `plugin-load-${Date.now()}`);
await mkdir(folder, { recursive: true });
const plugin = join(root, 'plugin/bin/Release/net8.0-windows/MyCivil3DMcp.Plugin.dll');
const harness = join(root, 'tests/CivilCrud.Native/bin/Release/net8.0-windows/CivilCrud.Native.dll');
const script = join(folder, 'load.scr');
await writeFile(script, ['FILEDIA', '0', 'SECURELOAD', '0',
  '(arxload "C:/Program Files/Autodesk/AutoCAD 2025/C3D/AeccLand.dbx")',
  '_.NETLOAD', `"${plugin.replaceAll('\\', '/')}"`,
  '_.NETLOAD', `"${harness.replaceAll('\\', '/')}"`, 'MYC3DLOADTEST', '_.QUIT', '_Yes', ''].join('\r\n'));
const child = spawn('C:/Program Files/Autodesk/AutoCAD 2025/accoreconsole.exe',
  ['/isolate', 'MyCivil3DLoadTest', join(folder, 'profile'), '/s', script, '/l', 'en-US'], {
    cwd: folder, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env,
      MY_CIVIL3D_LOAD_TEST_DIR: folder, MY_CIVIL3D_TEST_PLUGIN: plugin,
      MY_CIVIL3D_SERVER_ENTRY: join(root, 'server/build/localService.js'),
      MY_CIVIL3D_DATA_DIR: join(folder, 'data'), MY_CIVIL3D_CONNECTION_DIR: join(folder, 'connections'),
      MY_CIVIL3D_SYNC: 'off', MY_CIVIL3D_AUTO_UPDATE: 'off' }
  });
const chunks = [];
child.stdout.on('data', chunk => chunks.push(chunk));
child.stderr.on('data', chunk => chunks.push(chunk));
const timer = setTimeout(() => spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }), 60000);
let code;
try { code = await new Promise((done, reject) => { child.once('close', done); child.once('error', reject); }); }
finally { clearTimeout(timer); }
await writeFile(join(folder, 'load.log'), Buffer.concat(chunks));
const result = await readFile(join(folder, 'load-result.json'), 'utf8').then(JSON.parse).catch(() => undefined);
console.log(JSON.stringify({ folder, code, result: result ?? 'NETLOAD did not produce a result; inspect load.log.' }));
if (code !== 0 || !result?.passed) process.exitCode = 1;
