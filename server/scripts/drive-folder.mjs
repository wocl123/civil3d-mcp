import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { folderId, parsePublicFolder, listPublicFolder, configureFolder } from '../../scripts/drive-folder.mjs';
const temp = await mkdtemp(join(tmpdir(), 'mycivil3d-folder-'));
const root = 'ROOT_FOLDER_1234', release = 'RELEASE_FOLDER_1234', manifest = 'MANIFEST_FILE_1234', installer = 'INSTALLER_FILE_1234';
const html = rows => "window['_DRIVE_ivd'] = '" + JSON.stringify([rows]).split('').map(c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')).join('') + "';";
const rootHtml = html([[release, [root], 'MyCivil3DMcp-release', 'application/vnd.google-apps.folder']]);
let rows = [[manifest, [release], 'latest.json', 'application/json'], [installer, [release], '설치.exe', 'application/octet-stream']];
const server = createServer((req, res) => {
  if (req.url === '/' + root) res.end(rootHtml);
  else if (req.url === '/' + release) res.end(html(rows));
  else { res.writeHead(403); res.end('sign in'); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
process.env.MY_CIVIL3D_FOLDER_BASE = 'http://127.0.0.1:' + server.address().port + '/';
try {
  assert.equal(folderId('https://drive.google.com/drive/folders/' + root + '?usp=sharing'), root);
  assert.throws(() => folderId('https://drive.google.com/file/d/abc/view'));
  assert.equal(parsePublicFolder(rootHtml)[0].name, 'MyCivil3DMcp-release');
  assert.throws(() => parsePublicFolder('<html>Sign in</html>'), /공개 폴더/);
  await assert.rejects(listPublicFolder('NO_ACCESS_FOLDER'), /403/);
  const configFile = join(temp, 'config.json');
  await writeFile(configFile, JSON.stringify({ folderLink: 'https://drive.google.com/drive/folders/' + root }));
  const first = await configureFolder(configFile, false, 0);
  assert.equal(first.manifestId, manifest);
  const next = await configureFolder(configFile, true, 0);
  assert.equal(next.installerId, installer);
  assert.equal(JSON.parse(await readFile(configFile, 'utf8')).releaseFolderId, release);
  rows.push([manifest + 'copy', [release], 'latest.json', 'application/json']);
  await assert.rejects(configureFolder(configFile, false, 0), /여러 개/);
  console.log('drive folder ok: one shared folder link resolves manifest and EXE, Korean names, denied access and duplicate files refused');
} finally {
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  await rm(temp, { recursive: true, force: true });
}
