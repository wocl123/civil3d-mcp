// Actual Apps Script code + actual client + filesystem-backed simulated Drive.
// No Google account, live Drive folder, local user data or Civil 3D is touched.
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
const temp = mkdtempSync(join(tmpdir(), 'mycivil3d-ingest-test-'));
const data = join(temp, 'user'), drive = join(temp, 'drive');
mkdirSync(data); mkdirSync(drive);
process.env.MY_CIVIL3D_DATA_DIR = data;
process.env.MY_CIVIL3D_CONNECTION_FILE = join(temp, 'missing-connection.json');
process.env.MY_CIVIL3D_DRIVE_DIR = join(temp, 'drive-not-installed');
delete process.env.MY_CIVIL3D_ADMIN_CONSOLE;
const endpoint = 'https://script.google.com/macros/s/TEST_AUTOMATIC_INGEST_DEPLOYMENT_123456/exec';
const props = new Map(), folders = new Map(), files = new Map();
const iterator = list => { let i = 0; return { hasNext: () => i < list.length, next: () => list[i++] }; };
class File {
  constructor(path) { this.path = path; this.access = 'PRIVATE'; this.editors = []; this.viewers = []; files.set(path, this); }
  getSharingAccess() { return this.access; }
  getEditors() { return this.editors; }
  getViewers() { return this.viewers; }
  getName() { return this.path.split(/[\\/]/).at(-1); }
  getBlob() { return { getDataAsString: () => readFileSync(this.path, 'utf8') }; }
  setContent(s) { writeFileSync(this.path, s); }
}
class Folder {
  constructor(path) { this.path = path; this.access = 'PRIVATE'; this.editors = []; this.viewers = []; folders.set(path, this); }
  getId() { return this.path; }
  getName() { return this.path.split(/[\\/]/).at(-1); }
  getUrl() { return 'https://drive.google.com/folders/simulated'; }
  getSharingAccess() { return this.access; }
  getEditors() { return this.editors; }
  getViewers() { return this.viewers; }
  setSharing(a) { this.access = a; }
  getFilesByName(n) { const path = join(this.path, n); return iterator(existsSync(path) ? [files.get(path) ?? new File(path)] : []); }
  createFile(n, s) { const path = join(this.path, n); writeFileSync(path, s); return new File(path); }
  getFiles() { return iterator(readdirSync(this.path, { withFileTypes: true }).filter(x => x.isFile()).map(x => files.get(join(this.path, x.name)) ?? new File(join(this.path, x.name)))); }
  getFolders() { return iterator(readdirSync(this.path, { withFileTypes: true }).filter(x => x.isDirectory()).map(x => folders.get(join(this.path, x.name)))); }
  getFoldersByName(n) { const path = join(this.path, n); return iterator(folders.has(path) ? [folders.get(path)] : []); }
  createFolder(n) { const path = join(this.path, n); mkdirSync(path); return new Folder(path); }
}
const context = vm.createContext({
  console: { log() {} }, MimeType: { PLAIN_TEXT: 'text/plain' },
  ContentService: { MimeType: { JSON: 'application/json' }, createTextOutput: s => ({ text: s, setMimeType() { return this; } }) },
  PropertiesService: { getScriptProperties: () => ({ getProperty: k => props.get(k), setProperty: (k, v) => props.set(k, v) }) },
  LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
  Utilities: { DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' },
    computeDigest: (_, s) => [...createHash('sha256').update(s).digest()],
    newBlob: s => ({ getBytes: () => [...Buffer.from(s)] }) },
  ScriptApp: { getService: () => ({ getUrl: () => endpoint }) },
  DriveApp: { Access: { PRIVATE: 'PRIVATE' }, Permission: { NONE: 'NONE' },
    createFolder: n => { const path = join(drive, n); mkdirSync(path); return new Folder(path); },
    getFolderById: id => { if (!folders.has(id)) throw Error('missing'); return folders.get(id); } }
});
const generated = resolve('../scripts/google-ingest/Validation.gs');
if (!existsSync(generated)) throw Error('Run node ../scripts/build-ingest.mjs first.');
vm.runInContext(readFileSync(generated, 'utf8') + '\n' + readFileSync(resolve('../scripts/google-ingest/Code.gs'), 'utf8'), context);
const post = body => JSON.parse(context.doPost({ contentLength: Buffer.byteLength(JSON.stringify(body)), postData: { contents: JSON.stringify(body) } }).text);
assert.equal(JSON.parse(context.doGet().text).ready, false);
context.setupIntake();
assert.equal(JSON.parse(context.doGet().text).ready, true);
const intakeRoot = props.get('MC_INTAKE_ROOT_ID');
assert.equal(context.setupIntake().folderName, 'MyCivil3DMcp-data');
assert.equal(readdirSync(drive).length, 1);
let mode = 'bad-ack', requests = [];
let redirectReply;
const server = createServer(async (req, res) => {
  if (req.url === '/reply') { assert.equal(req.method, 'GET'); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(redirectReply)); return; }
  let text = ''; for await (const chunk of req) text += chunk;
  const body = JSON.parse(text); requests.push(body);
  if (mode === 'network-fails') { res.writeHead(503); res.end('offline'); return; }
  if (mode === 'html') { res.end('<html>login required</html>'); return; }
  if (mode === 'large-response') { res.end('x'.repeat(600 * 1024)); return; }
  const reply = post(body);
  if (mode === 'redirect') { redirectReply = reply; res.writeHead(303, { location: '/reply' }); res.end(); return; }
  if (mode === 'bad-ack' && body.action === 'package' && reply.ok) reply.sha256 = '0'.repeat(64);
  res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(reply));
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
process.env.MY_CIVIL3D_INGEST_TEST_URL = 'http://127.0.0.1:' + server.address().port + '/exec';
async function adminOnce(action, targetId) {
  const args = action ? ['-e', `import('./build/workflows/centralCommands.js').then(async m=>{await m.centralCommand('/중앙 관리자','test-admin');await m.centralCommand('/중앙 사용자','test-admin');const s=await import('./build/workflows/shownLists.js');const n=s.lastShown('test-admin','members').indexOf('${targetId}')+1;console.log(await m.centralCommand('/중앙 사용자 '+n+' ${action}','test-admin'))})`] : ['build/admin/console.js', '--once'];
  const child = spawn(process.execPath, args, { env: { ...process.env,
    MY_CIVIL3D_DATA_DIR: join(temp, 'admin'), MY_CIVIL3D_DRIVE_DIR: intakeRoot, MY_CIVIL3D_ADMIN_CONSOLE: '1' }, windowsHide: true });
  let out = ''; child.stdout.on('data', x => out += x); child.stderr.on('data', x => out += x);
  assert.equal(await new Promise(r => child.on('exit', r)), 0, out);
  return out;
}
try {
  const { validIngestUrl } = await import('../build/ingest/config.js');
  assert.ok(validIngestUrl(endpoint));
  for (const url of ['http://script.google.com/macros/s/abc/exec', endpoint + '?key=x', endpoint.replace('/exec', '/dev'), endpoint.replace('google.com', 'google.com.evil.test')])
    assert.equal(validIngestUrl(url), false);
  writeFileSync(join(data, 'team.json'), JSON.stringify({ adminEmail: 'test@example.com', ingestUrl: endpoint }));
  const { logTurn, logTool, logFeedback } = await import('../build/logs/workLog.js');
  const { addCandidates, unsentCandidates } = await import('../build/knowledge/candidateStore.js');
  const { install } = await import('../build/data/install.js');
  const { runSync } = await import('../build/sync/syncLoop.js');
  const { loadState } = await import('../build/sync/syncState.js');
  const { centralCommand } = await import('../build/workflows/centralCommands.js');
  const { installId } = await install();
  await logTurn({ requestId: 'test-turn-0001', provider: 'claude', question: 'C:\\Users\\Test\\Secret.dwg 의 선형 개수', answer: '선형 3개', kind: 'chat', ms: 10 });
  await logTool({ requestId: 'test-turn-0001', tool: 'list_alignments', ok: true, ms: 2 });
  await logFeedback({ requestId: 'test-turn-0001', rating: 'bad', reason: '레이어 삭제기능 추가필요' });
  const pending = join(data, 'outbox', 'pending');
  const first = await runSync();
  assert.match(first.error, /수신 확인/);
  assert.equal(readdirSync(pending).length, 1, 'unconfirmed data remains local');
  const member = join(intakeRoot, 'MyCivil3DMcp-' + installId), packages = join(member, 'packages');
  assert.equal(readdirSync(packages).length, 1, 'server stored data before reply was lost');
  const storedText = readFileSync(join(packages, readdirSync(packages)[0]), 'utf8');
  assert.ok(!storedText.includes('Secret.dwg') && !storedText.includes('C:\\Users'));
  assert.equal(JSON.parse(storedText).records.length, 3);
  const credentials = JSON.parse(readFileSync(join(data, 'state', 'ingest-credentials.json'), 'utf8'));
  const auth = JSON.parse(readFileSync(join(member, '.receiver-auth.json'), 'utf8'));
  assert.ok(!JSON.stringify(auth).includes(credentials.token));
  await addCandidates([{ title: '반지름', content: '반지름은 10 m 단위로 올림', evidence: 'private evidence', parameter: { key: 'alignment.radiusStep', value: 10 } }], 'Secret.dwg', 'claude');
  mode = 'redirect';
  const retried = await runSync();
  mode = 'ok';
  assert.equal(retried.sent, 1);
  assert.equal(retried.candidates, 1);
  assert.equal(readdirSync(pending).length, 0);
  assert.equal(readdirSync(packages).length, 1, 'retry did not duplicate stored package');
  assert.equal((await unsentCandidates()).length, 0);
  assert.equal((await loadState()).sentPackages, 1);
  const status = await centralCommand('/중앙');
  assert.match(status, /관리자 자동 수신/); assert.match(status, /확인됨/);
  assert.ok(!existsSync(process.env.MY_CIVIL3D_DRIVE_DIR), 'no user Drive required');
  const base = { schema: 1, installId, token: credentials.token, appVersion: '0.1.4' };
  assert.equal(post({ ...base, action: 'pull', token: 'f'.repeat(64) }).code, 'AUTH_FAILED');
  const sent = requests.find(x => x.action === 'package').package;
  assert.equal(post({ ...base, action: 'package', package: { ...sent, records: [{ type: 'turn', at: sent.createdAt, question: 'changed' }] } }).code, 'PACKAGE_CONFLICT');
  const unsafe = { ...sent, packageId: installId + '-unsafe', records: [{ type: 'turn', at: sent.createdAt, question: 'C:\\Secret\\file.dwg' }] };
  assert.equal(post({ ...base, action: 'package', package: unsafe }).code, 'INVALID_DATA');
  assert.equal(post({ ...base, action: 'package', package: { ...sent, packageId: installId + '-unknown', records: [{ type: 'arbitrary', at: sent.createdAt }] } }).code, 'INVALID_RECORD');
  assert.equal(post({ ...base, action: 'package', package: { ...sent, installId: '0'.repeat(16) } }).code, 'INVALID_DATA');
  // A second install is registered separately and cannot access the first install.
  const second = { schema: 1, action: 'register', installId: '1234567890abcdef', token: 'a'.repeat(64) };
  assert.equal(post(second).ok, true);
  assert.equal(post({ ...second, action: 'pull', installId }).code, 'AUTH_FAILED');
  assert.ok(!('token' in JSON.parse(context.doGet().text)));
  assert.equal(post({ ...base, action: 'getPackages' }).code, 'INVALID_REQUEST');
  const adminOutput = await adminOnce();
  assert.match(adminOutput, /사용자 2/);
  const adminRows = readFileSync(join(temp, 'admin', 'admin', 'records', new Date().toISOString().slice(0, 7) + '.jsonl'), 'utf8').trim().split('\n');
  assert.equal(adminRows.length, 3);
  assert.ok(existsSync(join(member, 'admin', 'received.json')));
  assert.match(await adminOnce(), /기록 0/);
  const official = { version: 1, items: [{ id: 'S-1', content: '반지름 10 m 올림', approvedAt: new Date().toISOString() }], parameters: { 'alignment.radiusStep': 10 } };
  writeFileSync(join(member, 'admin', 'official.json'), JSON.stringify(official));
  assert.equal((await runSync()).official, 1);
  assert.ok(readFileSync(join(data, 'knowledge', 'rules', '중앙_지식.md'), 'utf8').includes('반지름 10 m'));
  await logTurn({ requestId: 'test-turn-0002', question: '다음 질문', answer: '테스트', ms: 10 });
  mode = 'network-fails';
  assert.match((await runSync()).error, /HTTP 503/); assert.equal(readdirSync(pending).length, 1);
  mode = 'html';
  assert.match((await runSync()).error, /JSON/); assert.equal(readdirSync(pending).length, 1);
  mode = 'large-response';
  assert.match((await runSync()).error, /응답 크기 초과/); assert.equal(readdirSync(pending).length, 1);
  mode = 'ok';
  assert.match(await adminOnce('차단', installId), /차단했습니다/);
  assert.equal(JSON.parse(readFileSync(join(member, 'admin', 'control.json'), 'utf8')).blocked, true);
  assert.match((await runSync()).error, /MEMBER_BLOCKED/); assert.equal(readdirSync(pending).length, 1);
  assert.match(await adminOnce('해제', installId), /차단을 풀었습니다/);
  assert.equal(JSON.parse(readFileSync(join(member, 'admin', 'control.json'), 'utf8')).blocked, false);
  assert.equal((await runSync()).sent, 1); assert.equal((await loadState()).sentPackages, 2);
  // Quota/public-folder errors never accept a new payload.
  folders.get(intakeRoot).access = 'ANYONE';
  assert.equal(JSON.parse(context.doGet().text).ready, false);
  assert.equal(post({ ...base, action: 'pull' }).code, 'COLLECTION_FOLDER_MUST_BE_PRIVATE');
  folders.get(intakeRoot).access = 'PRIVATE';
  // Individually shared items are PRIVATE too; refuse explicit readers/editors throughout the intake path.
  const rootFolder = folders.get(intakeRoot);
  assert.equal(context.auditIntakePermissions().safe, true);
  rootFolder.viewers = ['external-reader'];
  assert.equal(context.auditIntakePermissions().safe, false);
  assert.equal(JSON.parse(context.doGet().text).ready, false);
  assert.equal(post({ ...base, action: 'pull' }).code, 'COLLECTION_FOLDER_MUST_BE_PRIVATE');
  rootFolder.viewers = [];
  folders.get(member).editors = ['external-editor'];
  assert.equal(post({ ...base, action: 'pull' }).code, 'COLLECTION_FOLDER_MUST_BE_PRIVATE');
  folders.get(member).editors = [];
  const candidateFolder = folders.get(join(member, 'candidates'));
  candidateFolder.access = 'ANYONE_WITH_LINK';
  assert.equal(post({ ...base, action: 'candidates', candidates: [] }).code, 'COLLECTION_FOLDER_MUST_BE_PRIVATE');
  candidateFolder.access = 'PRIVATE';
  const officialFile = join(member, 'admin', 'official.json');
  files.get(officialFile).viewers = ['external-reader'];
  const sharedReply = post({ ...base, action: 'pull' });
  assert.equal(sharedReply.code, 'COLLECTION_FOLDER_MUST_BE_PRIVATE');
  assert.ok(!('official' in sharedReply));
  files.get(officialFile).viewers = [];
  const unsafeKey = { ...sent, packageId: installId + '-key-test', records: [{ type: 'turn', at: sent.createdAt, question: 'sk-' + 'a'.repeat(32) }] };
  assert.equal(post({ ...base, action: 'package', package: unsafeKey }).code, 'INVALID_DATA');
  assert.equal(post({ ...base, action: 'register', token: [base.token] }).code, 'INVALID_REQUEST');
  const authPath = join(member, '.receiver-auth.json'), limited = JSON.parse(readFileSync(authPath, 'utf8'));
  writeFileSync(authPath, JSON.stringify({ ...limited, requests: 500 }));
  const budgetBefore = props.get('MC_INTAKE_DAILY');
  assert.equal(post({ ...base, action: 'pull' }).code, 'MEMBER_DAILY_LIMIT');
  assert.equal(post({ ...base, action: 'register' }).code, 'MEMBER_DAILY_LIMIT');
  assert.equal(props.get('MC_INTAKE_DAILY'), budgetBefore, 'per-install refusal does not drain everyone else\'s budget');
  const { exportLogs } = await import('../build/sync/exporter.js');
  for (let i = 0; i < 140; i++) await logTurn({ requestId: 'large-turn-' + String(i).padStart(8, '0'), question: '큰 답변', answer: 'x'.repeat(7800), ms: 1 });
  const big = await exportLogs(await loadState());
  assert.equal(big.records, 140);
  assert.ok(big.packages >= 2, 'large logs are split for the web transport');
  for (const name of readdirSync(pending)) assert.ok(Buffer.byteLength(readFileSync(join(pending, name), 'utf8')) < 540 * 1024);
  console.log('ingest e2e ok: no user Drive/login, automatic registration, actual receiver validation, privacy, lost-reply retry/dedup, candidate ack, multi-user isolation, admin import, approved knowledge, offline/HTML retry, blocking and quotas');
} finally {
  server.closeAllConnections(); await new Promise(r => server.close(r));
  rmSync(temp, { recursive: true, force: true });
}
