// 레이어 계획 → 동의 → 적용 → 되돌리기. 실제 Civil 3D 대신 테스트 브리지를 쓴다.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { bumpRevision, failMethod, setDrawing, startFakeCivil } from './fixtures/fake-civil.mjs';
import { blockLayer, layerInfo, layerNames } from './fixtures/fake-layers.mjs';

const temporary = await mkdtemp(join(tmpdir(), 'my-civil3d-layers-'));
const connection = join(temporary, 'connection.json');
const env = { ...process.env, MY_CIVIL3D_CONNECTION_FILE: connection, MY_CIVIL3D_DATA_DIR: temporary,
  MY_CIVIL3D_SYNC: 'off', MY_CIVIL3D_MCP_PROFILE: 'palette' };
const bridge = await startFakeCivil(connection);
const clients = new Set();
let request = 0;

async function palette(offered = '') {
  const client = new Client({ name: 'layer-scenario', version: '0.1.0' });
  clients.add(client);
  await client.connect(new StdioClientTransport({
    command: process.execPath, args: [fileURLToPath(new URL('../build/index.js', import.meta.url))], stderr: 'pipe',
    env: { ...env, MY_CIVIL3D_OFFERED_FIXES: offered, MY_CIVIL3D_REQUEST_ID: `layers-${++request}` }
  }));
  return client;
}

async function call(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content[0].text;
  let data;
  try {
    data = JSON.parse(text);
  }
  catch {
    assert.equal(result.isError, true, text);
    data = { error: text };
  }

  return { error: result.isError === true, data };
}

async function planCreate(client, name) {
  const result = await call(client, 'plan_layer_create', { layers: [{ name }] });
  assert.equal(result.error, false, JSON.stringify(result.data));
  return result.data.option.id;
}

try {
  process.env.MY_CIVIL3D_DATA_DIR = temporary;
  process.env.MY_CIVIL3D_CONNECTION_FILE = connection;
  const { applyFix, undoOperation, confirmOperation } = await import('../build/changes/applyChange.js');
  const { cancelFix, fixCard, operationStatus } = await import('../build/changes/operations.js');
  const { loadFix } = await import('../build/changes/changeStore.js');
  const planner = await palette();
  const tools = (await planner.listTools()).tools.map(tool => tool.name);
  assert.ok(tools.includes('plan_layer_create') && tools.includes('plan_layer_delete'));
  assert.ok(tools.includes('apply_drawing_change'));

  const before = layerNames();
  const plan = await call(planner, 'plan_layer_create', { layers: [
    { name: '새 도로', color: 3 }, { name: '검토선' }, { name: 'c-road-cl', color: 1 }, { name: '잘못|이름' }
  ] });
  assert.equal(plan.error, false, JSON.stringify(plan.data));
  assert.equal(plan.data.layers.length, 2);
  assert.equal(plan.data.layers[1].after.color, 7);
  assert.equal(plan.data.blocked.length, 2);
  assert.deepEqual(layerNames(), before, 'planning does not change layers');
  const createId = plan.data.option.id;
  assert.equal(fixCard(await loadFix(createId)).kind, 'create');
  assert.equal((await call(planner, 'apply_drawing_change', { fixId: createId })).error, true);
  assert.equal((await call(planner, 'plan_layer_create', { layers: [{ name: 'DUP' }, { name: 'dup' }] })).error, true);
  for (const color of [0, 256, 1.5]) {
    assert.equal((await call(planner, 'plan_layer_create', { layers: [{ name: '색상오류', color }] })).error, true);
  }

  const applier = await palette(createId);
  const applied = await call(applier, 'apply_drawing_change', { fixId: createId });
  assert.equal(applied.error, false, JSON.stringify(applied.data));
  assert.deepEqual(applied.data.createdLayers, ['새 도로', '검토선']);
  assert.equal(layerInfo('새 도로').color, 3);
  assert.equal(layerInfo('검토선').color, 7);
  assert.equal(layerInfo('C-ROAD-CL').color, 2, 'existing properties preserved');
  assert.equal(applied.data.recheck.state, 'not_required');
  assert.equal((await call(applier, 'apply_drawing_change', { fixId: createId })).error, true, 'no duplicate apply');
  await undoOperation(applied.data.operationId, [createId]);
  assert.deepEqual(layerNames(), before, 'undo removes newly created layers');
  const reapplied = await applyFix(createId, [createId], 'layer-reapply', applied.data.operationId);
  assert.equal(reapplied.applied, true);

  const deletion = await call(planner, 'plan_layer_delete', { names: [
    '검토선', '0', 'Defpoints', 'CURRENT', 'XREF|ROAD', 'C-ROAD-CL', 'LAYOUT-ONLY', 'BLOCK-ONLY', 'STYLE-ONLY', '없는레이어'
  ] });
  assert.equal(deletion.error, false, JSON.stringify(deletion.data));
  assert.equal(deletion.data.layers.length, 1);
  assert.equal(deletion.data.blocked.length, 9);
  const deleteId = deletion.data.option.id;
  assert.equal(fixCard(await loadFix(deleteId)).kind, 'delete');
  assert.ok(layerInfo('검토선'), 'delete preview leaves layer intact');
  const removed = await applyFix(deleteId, [deleteId], 'layer-delete');
  assert.equal(removed.applied, true);
  assert.deepEqual(removed.deletedLayers, ['검토선']);
  assert.equal(layerInfo('검토선'), undefined);
  await undoOperation(removed.operationId, [deleteId]);
  assert.equal(layerInfo('검토선').color, 7, 'undo restores deleted layer properties');
  await assert.rejects(applyFix(deleteId, [deleteId], 'delete-again', removed.operationId), /새로 요청/);
  const noTargets = await call(planner, 'plan_layer_delete', { names: ['0', '없는레이어'] });
  assert.equal(noTargets.data.option, null);

  const cancelled = await planCreate(planner, '취소레이어');
  await cancelFix(cancelled, [cancelled]);
  await assert.rejects(applyFix(cancelled, [cancelled]), /cancelled/);
  const stale = await planCreate(planner, '오래된계획');
  bumpRevision();
  await assert.rejects(applyFix(stale, [stale]), /Drawing changed/);
  const otherDrawing = await planCreate(planner, '다른도면');
  setDrawing('another-drawing');
  await assert.rejects(applyFix(otherDrawing, [otherDrawing]), /Drawing changed/);
  setDrawing('fake-drawing-1');

  // 적용 직전에도 삭제 가능 여부를 다시 확인하고, 일부만 삭제하지 않는다.
  const race = await call(planner, 'plan_layer_delete', { names: ['새 도로', '검토선'] });
  blockLayer('검토선', '도면 설정에서 사용 중');
  const refused = await applyFix(race.data.option.id, [race.data.option.id]);
  assert.equal(refused.applied, false);
  assert.ok(layerInfo('새 도로') && layerInfo('검토선'), 'refusal preserves every target');
  blockLayer('검토선', undefined);

  const lost = await planCreate(planner, '응답유실');
  failMethod('after.disconnect', 'response lost');
  const unknown = await applyFix(lost, [lost], 'layer-lost');
  failMethod('after.disconnect');
  assert.equal(unknown.mutation, 'unknown');
  assert.ok(layerInfo('응답유실'), 'committed layer survives lost response');
  const receipt = await operationStatus(lost, [lost]);
  assert.equal(receipt.state, 'applied');
  await undoOperation(receipt.operationId, [lost]);
  assert.equal(layerInfo('응답유실'), undefined);

  const finalId = await planCreate(planner, '확정레이어');
  const final = await applyFix(finalId, [finalId]);
  bumpRevision();
  await assert.rejects(undoOperation(final.operationId, [finalId]), /undo conflict/);
  const confirmed = await confirmOperation(final.operationId, [finalId]);
  assert.equal(confirmed.state, 'confirmed');
  assert.equal(confirmed.result, undefined);
  await assert.rejects(undoOperation(final.operationId, [finalId]), /확정한 작업/);
  console.log('layer scenario passed: planning, colours, blocked layers, consent, apply, undo, cancellation, ' +
    'stale plans, atomic refusal, lost response, confirm');
}
finally {
  failMethod('after.disconnect');
  await Promise.all([...clients].map(client => client.close()));
  await new Promise(resolve => bridge.close(resolve));
  await rm(temporary, { recursive: true, force: true });
}
