// Real admin command/store + a temporary Drive tree; never touches the actual collection.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rename, rm, symlink, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const temp = await mkdtemp(join(tmpdir(), 'mc-case-clean-'));
const root = join(temp, 'drive');
process.env.MY_CIVIL3D_DATA_DIR = join(temp, 'data');
process.env.MY_CIVIL3D_DRIVE_DIR = root;
process.env.MY_CIVIL3D_ADMIN_CONSOLE = '1';
process.env.MY_CIVIL3D_SYNC = 'off';
const { AdminStore, adminStore } = await import('../build/admin/adminStore.js');
const { decideCase } = await import('../build/admin/review.js');
const { cleanupDriveCases } = await import('../build/admin/caseCleanup.js');
const { adminSync } = await import('../build/admin/adminSync.js');
const { centralCommand } = await import('../build/workflows/centralCommands.js');
const { saveSettings } = await import('../build/data/settings.js');
const store = adminStore();
const a = '0123456789abcdef', b = 'fedcba9876543210';
const folder = join(root, 'collection', `MyCivil3DMcp-${a}`);
const other = join(root, `MyCivil3DMcp-${b}`);
const at = '2026-10-16T04';
const key = id => `${a}:${id}`;
const turn = id => ({ type: 'turn', id, at, question: `question ${id}`, answer: 'answer', ms: 42, errorKind: 'not_found' });
let sequence = 0;
async function member(id, path, name) {
  await mkdir(join(path, 'packages'), { recursive: true });
  await writeFile(join(path, 'member.json'), JSON.stringify({ app: 'my-civil3d-mcp', schema: 1, installId: id }));
  store.members[id] = { installId: id, folder: name, firstSeen: at, lastSeen: at, seen: true };
}
async function pack(records, { dir = folder, id = a, day, imported = true } = {}) {
  const packageId = `${id}-test-${++sequence}`;
  const path = join(dir, 'packages', ...(day ? [day] : []), packageId + '.json');
  await mkdir(join(dir, 'packages', ...(day ? [day] : [])), { recursive: true });
  const body = { schema: 1, installId: id, packageId, records, transportSha256: 'a'.repeat(64), marker: 'keep metadata' };
  await writeFile(path, JSON.stringify(body, null, 2));
  if (imported) store.addPackage(id, packageId, records);
  return { path, body };
}
const json = async path => JSON.parse(await readFile(path, 'utf8'));
try {
  await member(a, folder, `collection\\MyCivil3DMcp-${a}`);
  await member(b, other, `MyCivil3DMcp-${b}`);
  store.saveMembers();
  await saveSettings({ schema: 1, drive: { enabled: true, admin: true, root, since: at } });
  const target = turn('turn-done-0001'), unresolved = { ...turn('turn-todo-0002'), extra: 'keep raw fields' };
  const records = [target, { type: 'tool', turnId: target.id, at, tool: 'list_surfaces', input: 'query', ms: 1, ok: true },
    { type: 'change', turnId: target.id, at, state: 'failed', title: 'fix' },
    { type: 'feedback', turnId: target.id, at, rating: 'bad', reason: 'reason' }, unresolved];
  const mixed = await pack(records, { day: '2026-10-16' });
  const pure = await pack([target]);
  const foreign = await pack([target], { id: b, dir: other });
  decideCase(store, { key: key(target.id), action: 'done', version: '0.1.16' });
  const done = await cleanupDriveCases(store, root, [key(target.id)]);
  assert.equal(done.removedRecords, 5);
  assert.equal(done.deletedFiles, 1);
  assert.equal(done.rewrittenFiles, 1);
  assert.ok(done.freedBytes > 0);
  assert.equal(done.pendingCases, 0);
  assert.ok(!existsSync(pure.path));
  const kept = await json(mixed.path);
  assert.deepEqual(kept.records, [unresolved], 'mixed package retains other case and its original fields');
  assert.equal(kept.transportSha256, mixed.body.transportSha256, 'lost-reply transport receipt is retained');
  assert.equal(kept.marker, 'keep metadata');
  assert.deepEqual((await json(foreign.path)).records, [target], 'same turn ID on another install is protected');
  assert.equal(store.cases[key(target.id)].driveCleanup, 'done');
  assert.equal(store.records.find(row => row.installId === a && row.record.id === target.id).record.question, undefined);
  assert.equal(store.records.find(row => row.installId === a && row.record.id === target.id).record.ms, 42);
  assert.equal((await cleanupDriveCases(store, root)).removedRecords, 0, 'retries are idempotent');

  const late = await pack([target], { imported: false });
  const pending = await cleanupDriveCases(store, root);
  assert.equal(pending.pendingCases, 1, 'unimported data is never deleted');
  assert.ok(existsSync(late.path));
  store.addPackage(a, late.body.packageId, [target]);
  assert.equal(store.records.at(-1).record.question, undefined, 'late package cannot restore discarded content locally');
  assert.match(await centralCommand('/검토 드라이브정리'), /빈 파일 1개 삭제/);
  assert.ok(!existsSync(late.path), 'late cloud replay is removed at the next cleanup');

  const discard = turn('turn-drop-0003');
  const dropped = await pack([discard]);
  decideCase(store, { key: key(discard.id), action: 'discard' });
  await rename(root, root + '-offline');
  const offline = await cleanupDriveCases(store, root);
  assert.equal(offline.pendingCases, 2);
  assert.equal(new AdminStore().cases[key(discard.id)].driveCleanup, 'pending', 'pending deletion survives restart');
  await rename(root + '-offline', root);
  const synced = await adminSync({ enabled: true, admin: true, root, since: at }, {});
  assert.ok(synced.problems.some(message => /빈 파일 1개 삭제/.test(message)));
  assert.ok(!existsSync(dropped.path));

  const commandTarget = turn('turn-menu-0004');
  const commandFile = await pack([commandTarget]);
  decideCase(store, { key: key(commandTarget.id), action: 'todo', category: 'code' });
  await centralCommand('/검토 사례 할일', 'cleanup-test');
  const message = await centralCommand('/검토 사례 1 완료 0.1.16', 'cleanup-test');
  assert.match(message, /완료로 표시했습니다/);
  assert.match(message, /Drive 원본: 기록 1건 삭제/);
  assert.ok(!existsSync(commandFile.path), 'normal completion command cleans Drive immediately');

  const denied = await pack([turn('turn-denied-0005')]);
  decideCase(store, { key: key('turn-denied-0005'), action: 'todo', category: 'code' });
  await centralCommand('/검토 사례 할일', 'denied-test');
  delete process.env.MY_CIVIL3D_ADMIN_CONSOLE;
  assert.match(await centralCommand('/검토 사례 1 완료', 'denied-test'), /관리자실행.bat/);
  assert.ok(existsSync(denied.path), 'palette does not delete Drive source files');
  assert.equal(store.cases[key('turn-denied-0005')].status, 'todo', 'palette cannot change case status');
  process.env.MY_CIVIL3D_ADMIN_CONSOLE = '1';
  await centralCommand('/검토 사례 1 완료', 'denied-test');
  assert.ok(!existsSync(denied.path));

  const blocked = await pack([target]);
  store.members[a].blocked = true;
  assert.ok((await cleanupDriveCases(store, root)).pendingCases > 0);
  assert.ok(existsSync(blocked.path), 'blocked member is not modified');
  store.members[a].blocked = false;
  await cleanupDriveCases(store, root);

  const invalid = join(folder, 'packages', `${a}-invalid.json`);
  await writeFile(invalid, '{not json');
  const original = await readFile(invalid, 'utf8');
  assert.ok((await cleanupDriveCases(store, root)).pendingCases > 0);
  assert.equal(await readFile(invalid, 'utf8'), original, 'invalid packages are never rewritten');
  await unlink(invalid);

  const protectedFile = await pack([target], { dir: join(temp, 'outside-member') });
  const link = join(folder, 'packages', '2026-10-17');
  await symlink(join(temp, 'outside-member', 'packages'), link, 'junction');
  assert.ok((await cleanupDriveCases(store, root)).pendingCases > 0);
  assert.ok(existsSync(protectedFile.path), 'directory junction cannot escape the collection');
  await unlink(link);
  assert.equal((await cleanupDriveCases(store, root)).pendingCases, 0);
  assert.deepEqual((await json(mixed.path)).records, [unresolved], 'unresolved case survives every cleanup');
  console.log('Admin Drive cleanup passed: immediate completion, mixed/empty packages, linked records, install boundary, raw metadata, durable offline retry, replay protection, unimported/blocked/invalid/link guards and menu command.');
} finally {
  await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
