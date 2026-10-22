import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { bumpRevision, failMethod, startFakeCivil } from './fixtures/fake-civil.mjs';
import { civilObjects, restoreCivil } from './fixtures/fake-civil-plans.mjs';

const folder = await mkdtemp(join(tmpdir(), 'civil-crud-'));
const connection = join(folder, 'connection.json');
const bridge = await startFakeCivil(connection);
const clients = [];
let request = 0;
const env = { ...process.env, MY_CIVIL3D_CONNECTION_FILE: connection, MY_CIVIL3D_DATA_DIR: folder,
  MY_CIVIL3D_SYNC: 'off', MY_CIVIL3D_MCP_PROFILE: 'palette' };
async function client(offered = '') {
  const value = new Client({ name: 'civil-scenario', version: '1' });
  clients.push(value);
  await value.connect(new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL('../build/index.js', import.meta.url))], stderr: 'pipe',
    env: { ...env, MY_CIVIL3D_OFFERED_FIXES: offered, MY_CIVIL3D_REQUEST_ID: `civil-${++request}` } }));
  return value;
}
async function call(value, name, args) {
  const result = await value.callTool({ name, arguments: args });
  let data;
  try { data = JSON.parse(result.content[0].text); }
  catch { assert.equal(result.isError, true); data = { error: result.content[0].text }; }
  return { error: !!result.isError, data };
}
try {
  Object.assign(process.env, env);
  const { applyFix, undoOperation } = await import('../build/changes/applyChange.js');
  const { loadFix } = await import('../build/changes/changeStore.js');
  const { fixCard, operationStatus } = await import('../build/changes/operations.js');
  const planner = await client();
  const tools = (await planner.listTools()).tools;
  for (const name of ['plan_surface_create', 'plan_surface_edit', 'plan_surface_delete',
    'plan_profile_create', 'plan_profile_edit', 'plan_drawing_display', 'list_surfaces', 'get_surface',
    'list_pipe_networks', 'plan_pipe_network_delete']) {
    assert.ok(tools.some(tool => tool.name === name));
  }
  assert.deepEqual(tools.filter(tool => !tool.annotations.readOnlyHint).map(tool => tool.name), ['apply_drawing_change']);
  const networkFixtures = Array.from({ length: 60 }, (_, i) => ({ operation: 'network.fixture',
    name: i >= 58 ? `Raker-KickerBlock (${i})` : `1_계획_${i}`, handle: (1000 + i).toString(16), pipes: 2, structures: 7 }));
  restoreCivil(networkFixtures);
  const networkList = await call(planner, 'list_pipe_networks', { nameContains: 'raker-kickerblock', limit: 1 });
  assert.equal(networkList.data.total, 2, 'network filter sees targets beyond summary truncation');
  assert.equal(networkList.data.hasMore, true);
  assert.equal((await call(planner, 'list_pipe_networks', { nameContains: 'Raker', offset: 1, limit: 1 })).data.hasMore, false);
  for (const args of [{}, { nameContains: ' ' }, { networks: [] }, { network: 'x', nameContains: 'x' }]) {
    assert.equal((await call(planner, 'plan_pipe_network_delete', args)).error, true, 'invalid network selectors rejected');
  }
  const networkPlan = await call(planner, 'plan_pipe_network_delete', { nameContains: 'Raker-KickerBlock' });
  assert.equal(networkPlan.error, false, JSON.stringify(networkPlan.data));
  assert.equal(civilObjects().length, 60, 'network preview is read-only');
  const networkId = networkPlan.data.option.id;
  assert.equal(fixCard(await loadFix(networkId)).kind, 'delete');
  assert.equal((await call(planner, 'apply_drawing_change', { fixId: networkId })).error, true, 'network approval required');
  const networkApplier = await client(networkId);
  const networkApplied = await call(networkApplier, 'apply_drawing_change', { fixId: networkId });
  assert.equal(networkApplied.data.applied, true, JSON.stringify(networkApplied));
  assert.equal(civilObjects().length, 58, 'only selected networks deleted');
  await undoOperation(networkApplied.data.operationId, [networkId]);
  assert.equal(civilObjects().length, 60, 'network undo restored targets');
  restoreCivil([]);
  const create = await call(planner, 'plan_surface_create', { name: '지반', points: [
    { x: 0, y: 0, z: 10 }, { x: 100, y: 0, z: 12 }, { x: 0, y: 100, z: 15 }
  ] });
  assert.equal(create.error, false, JSON.stringify(create.data));
  assert.equal(civilObjects().length, 0, 'preview cannot mutate');
  const id = create.data.option.id;
  assert.equal(fixCard(await loadFix(id)).kind, 'create');
  assert.equal((await call(planner, 'apply_drawing_change', { fixId: id })).error, true, 'unoffered plan refused');
  const applier = await client(id);
  const applied = await call(applier, 'apply_drawing_change', { fixId: id });
  assert.equal(applied.data.applied, true);
  assert.equal(applied.data.civil.operation, 'surface.create');
  assert.equal(applied.data.recheck.state, 'not_required');
  assert.equal(civilObjects().length, 1);
  assert.equal((await call(applier, 'apply_drawing_change', { fixId: id })).error, true, 'duplicate refused');
  await undoOperation(applied.data.operationId, [id]);
  assert.equal(civilObjects().length, 0);
  await applyFix(id, [id], 'reapply', applied.data.operationId);
  assert.equal(civilObjects().length, 1);
  for (const [name, args, kind] of [
    ['plan_surface_edit', { surface: '지반', elevationDelta: 2 }, 'change'],
    ['plan_profile_create', { name: '계획선', alignment: '본선', type: 'layout',
      pvis: [{ station: 0, elevation: 10 }, { station: 100, elevation: 12 }] }, 'create'],
    ['plan_profile_create', { name: '지반선', alignment: '본선', type: 'surface', surface: '지반' }, 'create'],
    ['plan_profile_edit', { profile: '계획선', description: '수정' }, 'change'],
    ...['select', 'selectLayer', 'currentLayer', 'isolate', 'hide', 'restore', 'viewer'].map(action =>
      ['plan_drawing_display', { action, layer: '0', handles: ['B1'] }, 'change'])
  ]) {
    const plan = await call(planner, name, args);
    assert.equal(plan.error, false, JSON.stringify(plan.data));
    assert.equal(fixCard(await loadFix(plan.data.option.id)).kind, kind);
    const result = await applyFix(plan.data.option.id, [plan.data.option.id], `apply-${name}`);
    assert.equal(result.applied, true, JSON.stringify(result));
  }
  assert.equal((await call(planner, 'plan_surface_delete', { surface: '지반' })).error, true, 'dependency blocked');
  assert.equal((await call(planner, 'plan_surface_create', { name: 'bad', points: [{ x: 0, y: 0 }] })).error, true);
  assert.equal((await call(planner, 'plan_drawing_display', { action: 'execute', handles: ['B1'] })).error, true);
  const selection = await call(planner, 'plan_drawing_display', { action: 'select', handles: ['B1'] });
  const selectionId = selection.data.option.id;
  failMethod('after.commit', 'Reply lost after selection commit.');
  const uncertain = await applyFix(selectionId, [selectionId], 'lost-selection-reply');
  assert.equal(uncertain.mutation, 'unknown');
  failMethod('after.commit');
  const recovered = await operationStatus(selectionId, [selectionId]);
  assert.equal(recovered.state, 'applied');
  assert.equal(recovered.undoAvailable, false, 'lost reply recovery preserves selection undo metadata');
  const fresh = await call(planner, 'plan_surface_create', { name: '삭제대상' });
  await applyFix(fresh.data.option.id, [fresh.data.option.id], 'create-delete-target');
  const deletion = await call(planner, 'plan_surface_delete', { surface: '삭제대상' });
  const deleteId = deletion.data.option.id;
  assert.equal(fixCard(await loadFix(deleteId)).kind, 'delete');
  const deleted = await applyFix(deleteId, [deleteId], 'delete');
  assert.equal(deleted.applied, true);
  await undoOperation(deleted.operationId, [deleteId]);
  await assert.rejects(() => applyFix(deleteId, [deleteId], 'delete-again', deleted.operationId), /새로 요청/);
  const stale = await call(planner, 'plan_surface_edit', { surface: '지반', elevationDelta: 1 });
  bumpRevision();
  await assert.rejects(() => applyFix(stale.data.option.id, [stale.data.option.id], 'stale'), /Drawing changed/);
  console.log('Civil MCP plans: preview, consent, create/edit/delete/display, undo, stale plan and dependency guards passed.');
} finally {
  for (const value of clients) await value.close();
  await new Promise(done => bridge.close(done));
  await rm(folder, { recursive: true, force: true });
}
