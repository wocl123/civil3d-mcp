// 실제 도면과 AI 계정 없이 변경 경계·버튼 API·UTF-8·프로세스 정리를 검증한다.
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, relative } from 'node:path';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { randomUUID } from "node:crypto";
import { spawn } from 'node:child_process';
import { startFakeCivil, bumpRevision, setDrawing, failMethod } from './fixtures/fake-civil.mjs';

const temporary = await mkdtemp(join(tmpdir(), 'my-civil3d-safety-'));
process.env.MY_CIVIL3D_DATA_DIR = temporary;
process.env.MY_CIVIL3D_CONNECTION_FILE = join(temporary, 'connection.json');
process.env.MY_CIVIL3D_SYNC = 'off';
const bridge = await startFakeCivil(process.env.MY_CIVIL3D_CONNECTION_FILE);
const { normalizeQuestion, saveAnswer, findAnswer, hashKey } = await import('../build/memory/memoryStore.js');
const { currentDrawingScope } = await import('../build/memory/drawingScope.js');
const { contentVersion } = await import('../build/knowledge/contentVersion.js');
const { paletteVersion, paletteLaunch } = await import('../build/ai/paletteWorkspace.js');
const { checkAlignmentCriteria } = await import('../build/criteria/alignmentCriteria.js');
const { registerFixes, storeFix, loadFix } = await import('../build/changes/changeStore.js');
const { applyFix, undoOperation } = await import('../build/changes/applyChange.js');
const { usedFix, settleOperations } = await import('../build/changes/operations.js');
const { ReportBuilder, assess, fullItems } = await import('../build/criteria/reportBuilder.js');
const { loadCriteria, table } = await import('../build/criteria/criteriaStore.js');
const { withDrawing } = await import('../build/bridge/boundOperation.js');
const { callPlugin } = await import('../build/bridge/pluginClient.js');
const { terminateTree } = await import('../build/ai/processTree.js');
const { withFileLock, writeAtomic } = await import('../build/files.js');
let httpServer;
let checks = 0;
const check = async (name, work) => { await work(); checks++; console.log('ok: ' + name); };

async function radiusFix() {
  const report = await checkAlignmentCriteria({ alignment: 'B1', designSpeed: 100, maxSuperelevation: 6, area: '도시지역' });
  await registerFixes(fullItems(report), { check: 'alignment', input: { alignment: 'B1', designSpeed: 100, maxSuperelevation: 6, area: '도시지역' } });
  const option = fullItems(report).flatMap(item => item.fixes ?? []).find(fix => fix.applicable && fix.changes.some(c => c.object.kind === 'alignmentArc'));
  assert.ok(option, 'an applicable arc radius fix exists');
  return option;
}
try {
  await check('numeric punctuation and signs are preserved', async () => {
    assert.notEqual(normalizeQuestion('R=50.0'), normalizeQuestion('R=500'));
    assert.notEqual(normalizeQuestion('+3%'), normalizeQuestion('-3%'));
  });
  await check('old caches and other drawing instances are refused', async () => {
    const scope = await currentDrawingScope();
    const key = hashKey('test');
    await saveAnswer({ kind: 'chat', provider: 'codex', key, question: 'test', scope: scope.key, state: scope.state, drawingId: scope.drawingId, answer: 'test', usage: {} });
    assert.ok(await findAnswer('chat', 'codex', key, scope));
    assert.equal(await findAnswer('chat', 'codex', key, { ...scope, drawingId: 'another-instance' }), undefined);
    assert.equal(await findAnswer('chat', 'codex', key, { ...scope, drawingId: undefined }), undefined);
  });
  await check('lazy rule text and criteria edits invalidate versions', async () => {
    const before = await paletteVersion('codex');
    const rule = join(temporary, 'knowledge', 'rules', '선형.md');
    await writeFile(rule, (await readFile(rule, 'utf8')) + '\n추가 규칙\n');
    assert.notEqual(await paletteVersion('codex'), before);
    const criteriaBefore = await contentVersion();
    await mkdir(join(temporary, 'knowledge', 'criteria'), { recursive: true });
    await writeFile(join(temporary, 'knowledge', 'criteria', 'test.json'), '{}');
    assert.notEqual(await contentVersion(), criteriaBefore);
  });
  let fix;
  await check('fixes are bound to drawing and revision', async () => {
    fix = await radiusFix();
    setDrawing('other-drawing');
    await assert.rejects(applyFix(fix.id, [fix.id]), /Drawing changed/);
    setDrawing('fake-drawing-1'); bumpRevision();
    await assert.rejects(applyFix(fix.id, [fix.id]), /Drawing changed/);
  });
  await check('calculations refuse mixed revisions', async () => {
    await assert.rejects(withDrawing(async () => { bumpRevision(); return callPlugin('alignment.get', { alignment: 'B1' }); }), /Drawing changed/);
  });
  await check('criteria changes during calculation invalidate the entire result', async () => {
    const file = join(temporary, 'knowledge', 'criteria', 'test.json');
    await assert.rejects(withDrawing(async () => { await writeFile(file, '{"during":true}'); return 'stale'; }), /Criteria changed during/);
  });
  let applied;
  await check('post-commit recheck failure preserves applied state', async () => {
    fix = await radiusFix();
    failMethod('alignment.get', 'Injected recheck failure');
    applied = await applyFix(fix.id, [fix.id]);
    failMethod('alignment.get');
    assert.equal(applied.applied, true); assert.equal(applied.drawingChanged, true);
    assert.equal(applied.recheck.state, 'failed');
    assert.equal((await usedFix(fix.id)).state, 'applied');
    await assert.rejects(applyFix(fix.id, [fix.id]), /already applied/);
  });
  await check('undo and reapply use verified receipts', async () => {
    const undone = await undoOperation(applied.operationId, [fix.id]);
    assert.equal(undone.state, 'undone');
    const repeated = await undoOperation(applied.operationId, [fix.id]);
    assert.equal(repeated.state, 'undone');
    const reapplied = await applyFix(fix.id, [fix.id], 'reapply-test', applied.operationId);
    assert.equal(reapplied.applied, true);
    bumpRevision();
    await assert.rejects(undoOperation(reapplied.operationId, [fix.id]), /undo conflict/);
  });
  await check('lost commit responses stay unknown and are reconciled without reapplying', async () => {
    const option = { title: 'lost response test', status: 'feasible', effects: [], changes: [{ object: { kind: 'profilePvi', handle: 'C2', at: 420 }, property: 'elevation', from: 58.5, to: 58.7, unit: 'm' }] };
    await storeFix(option, '곡선 1', 'test', { check: 'none' });
    failMethod('after.commit', 'Injected lost response');
    const result = await applyFix(option.id, [option.id], 'lost-response-test');
    failMethod('after.commit');
    assert.equal(result.mutation, 'unknown'); assert.equal(result.drawingChanged, 'unknown');
    await assert.rejects(applyFix(option.id, [option.id]), /already applied/);
    await settleOperations('lost-response-test');
    assert.equal((await usedFix(option.id)).state, 'applied');
    assert.equal((await undoOperation(result.operationId, [option.id])).state, 'undone');
  });
  await check('cancellation tombstones block a delayed CAD change', async () => {
    const scope = await currentDrawingScope(); const operationId = randomUUID();
    await callPlugin('change.cancel', { operationId, drawingId: scope.drawingId });
    const { inDrawingContext } = await import('../build/bridge/drawingContext.js');
    await assert.rejects(inDrawingContext({ drawingId: scope.drawingId, revision: scope.state },
      () => callPlugin('change.apply', { operationId, changes: [{ kind: 'profilePvi', handle: 'C2', at: 420, property: 'elevation', from: 58.5, to: 59 }] })), /cancelled/);
  });
  await check('old, expired and changed-criteria fixes are refused', async () => {
    const option = { title: 'expiry test', status: 'feasible', effects: [], changes: [{ object: { kind: 'profilePvi', handle: 'C2', at: 420 }, property: 'elevation', from: 58.5, to: 58.9, unit: 'm' }] };
    await storeFix(option, '곡선 1', 'test', { check: 'none' });
    const file = join(temporary, 'changes', 'fixes', option.id + '.json');
    const stored = JSON.parse(await readFile(file, 'utf8'));
    await writeFile(file, JSON.stringify({ ...stored, binding: undefined }));
    await assert.rejects(applyFix(option.id, [option.id]), /no drawing identity/);
    await writeFile(file, JSON.stringify({ ...stored, createdAt: '2000-01-01T00:00:00Z' }));
    await assert.rejects(loadFix(option.id), /expired/);
    await writeFile(file, JSON.stringify(stored));
    await writeFile(join(temporary, 'knowledge', 'criteria', 'test.json'), '{"changed":true}');
    await assert.rejects(applyFix(option.id, [option.id]), /Criteria changed/);
  });
  await check('missing/review/empty checks are never pass and full results survive trimming', async () => {
    assert.equal(assess([]), 'incomplete'); assert.equal(assess([{ result: 'n/a' }]), 'incomplete');
    assert.equal(assess([{ result: 'review' }]), 'review'); assert.equal(assess([{ result: 'pass' }], true), 'incomplete');
    const set = await loadCriteria('도로구조규칙'); const builder = new ReportBuilder(set, 'test');
    for (let i = 0; i < 45; i++) builder.compare(table(set, 'min_curve_radius'), '곡선 ' + i, 1000, 100);
    const report = builder.build(); assert.equal(report.items.length, 0); assert.equal(fullItems(report).length, 45); assert.equal(report.assessment, 'pass');
  });
  await check('concurrent request workspaces are isolated', async () => {
    const [a,b] = await Promise.all([paletteLaunch('claude', true, 'request-a', ['fx-1111111111']), paletteLaunch('claude', true, 'request-b', ['fx-2222222222'])]);
    assert.notEqual(a.cwd, b.cwd);
    assert.equal(JSON.parse(await readFile(join(a.cwd, 'claude-mcp.json'), 'utf8')).mcpServers.civil3d.env.MY_CIVIL3D_OFFERED_FIXES, 'fx-1111111111');
    assert.equal(JSON.parse(await readFile(join(b.cwd, 'claude-mcp.json'), 'utf8')).mcpServers.civil3d.env.MY_CIVIL3D_REQUEST_ID, 'request-b');
  });
  await check('cross-process-style file updates are serialized', async () => {
    const path = join(temporary, 'counter.json'); await writeAtomic(path, '0');
    await Promise.all(Array.from({ length: 12 }, () => withFileLock(path, async () => {
      const value = Number(await readFile(path, 'utf8')); await new Promise(r => setTimeout(r, 5)); await writeAtomic(path, String(value + 1));
    })));
    assert.equal(await readFile(path, 'utf8'), '12');
  });
  await check('button HTTP APIs enforce conversation ownership and return undo results', async () => {
    // API를 같은 테스트 프로세스에서 띄워 실제 서비스 대화 저장소에 제안을 넣는다.
    const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
    const port = probe.address().port; await new Promise(r => probe.close(r));
    process.env.MY_CIVIL3D_SERVICE_PORT = String(port);
    const { remember } = await import('../build/workflows/conversation.js');
    ({ httpServer } = await import('../build/service/httpServer.js'));
    if (!httpServer.listening) await once(httpServer, 'listening');
    const { token } = JSON.parse(await readFile(process.env.MY_CIVIL3D_CONNECTION_FILE, 'utf8'));
    const option = { title: 'button elevation', status: 'feasible', effects: [], changes: [{ object: { kind: 'profilePvi', handle: 'C2', at: 420 }, property: 'elevation', from: 58.5, to: 58.6, unit: 'm' }] };
    await storeFix(option, '곡선 1', 'button test', { check: 'none' });
    remember('button-conversation', { provider: 'codex', question: 'offer', answer: 'offer', fixIds: [option.id] });
    const api = (path, body) => fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-my-civil3d-token': token }, body: JSON.stringify(body) });
    assert.equal((await api('/api/change/apply', { conversation: 'another-conversation', fixId: option.id })).status, 503);
    const result = await (await api('/api/change/apply', { conversation: 'button-conversation', fixId: option.id })).json();
    assert.equal(result.applied, true);
    const receipt = await (await api("/api/change/status", { conversation: "button-conversation", fixId: option.id })).json();
    assert.equal(receipt.state, "applied"); assert.equal(receipt.operationId, result.operationId);
    const undo = await (await api('/api/change/undo', { conversation: 'button-conversation', operationId: result.operationId })).json();
    assert.equal(undo.state, 'undone');
    const reapply = await (await api('/api/change/apply', { conversation: 'button-conversation', fixId: option.id, operationId: result.operationId })).json();
    assert.equal(reapply.applied, true);
  });
  await check('UTF-8 split at every byte boundary is preserved by real TCP client', async () => {
    const connection = process.env.MY_CIVIL3D_CONNECTION_FILE;
    const server = createServer(socket => socket.once('data', chunk => {
      const request = JSON.parse(chunk.toString());
      const bytes = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: '선형😀종단' }) + '\n');
      let i = 0; const timer = setInterval(() => { if (i < bytes.length) socket.write(bytes.subarray(i, ++i)); else { clearInterval(timer); socket.end(); } }, 1);
    }));
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    await writeFile(connection, JSON.stringify({ port: server.address().port, token: 'a'.repeat(64) }));
    assert.equal(await callPlugin('drawing.status'), '선형😀종단');
    await new Promise(r => server.close(r));
  });
  await check('timeout cleanup kills the owned child process tree', async () => {
    const code = `const {spawn}=require('child_process'); const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)']); console.log(c.pid); setInterval(()=>{},1000);`;
    const child = spawn(process.execPath, ['-e', code], { windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'ignore'] });
    const grandchild = Number((await once(child.stdout, 'data'))[0].toString().trim());
    const closed = once(child, 'close'); await terminateTree(child); await closed;
    await new Promise(r => setTimeout(r, 100));
    assert.throws(() => process.kill(grandchild, 0));
  });
  console.log(`safety regression passed: ${checks} scenarios`);
} finally {
  if (httpServer) await new Promise(r => httpServer.close(r));
  await new Promise(r => bridge.close(r));
  // 파괴적 정리 전에 이 테스트가 만든 임시 디렉터리 안인지 검사한다.
  const target = resolve(temporary); const inside = relative(resolve(tmpdir()), target);
  assert.ok(inside && !inside.startsWith('..') && !resolve(inside).startsWith('..'));
  await rm(target, { recursive: true, force: true });
}
