// 수정 요청 1~3: 잠긴 레이어 생성, 동결·잠금 변경, 객체 포함 삭제를 동의·Undo 경계까지 검증한다.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startFakeCivil } from './fixtures/fake-civil.mjs';
import { addLayerEntity, layerEntities, layerInfo, layerNames } from './fixtures/fake-layers.mjs';

const temp = await mkdtemp(join(tmpdir(), 'my-civil3d-layer-state-'));
process.env.MY_CIVIL3D_DATA_DIR = temp;
process.env.MY_CIVIL3D_CONNECTION_FILE = join(temp, 'connection.json');
const bridge = await startFakeCivil(process.env.MY_CIVIL3D_CONNECTION_FILE);
const client = new Client({ name: 'layer-state-scenario', version: '0.1.0' });
const { applyFix, undoOperation } = await import('../build/changes/applyChange.js');
const { loadFix } = await import('../build/changes/changeStore.js');
const { fixCard } = await import('../build/changes/operations.js');

async function plan(name, args) {
  const result = await client.callTool({ name, arguments: args });
  assert.notEqual(result.isError, true, JSON.stringify(result.content));
  return JSON.parse(result.content[0].text);
}

try {
  await client.connect(new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL('../build/index.js', import.meta.url))], stderr: 'pipe',
    env: { ...process.env, MY_CIVIL3D_MCP_PROFILE: 'palette', MY_CIVIL3D_REQUEST_ID: 'layer-state-test' }
  }));
  const tools = (await client.listTools()).tools;
  assert.ok(tools.some(tool => tool.name === 'plan_layer_edit' && tool.annotations.readOnlyHint));
  assert.deepEqual(tools.filter(tool => !tool.annotations.readOnlyHint).map(tool => tool.name), ['apply_drawing_change']);

  // 1. 생성 시 잠금·동결·꺼짐을 함께 지정하고, 계획만으로는 도면을 바꾸지 않는다.
  const initial = layerNames();
  const created = await plan('plan_layer_create', { layers: [
    { name: 'Version_Test', color: 3, locked: true, frozen: true, off: true }, { name: '보존레이어' }
  ] });
  assert.deepEqual(created.layers[0].after, { color: 3, locked: true, frozen: true, off: true });
  assert.deepEqual(layerNames(), initial);
  const createId = created.option.id;
  await assert.rejects(applyFix(createId, []), /not offered/);
  const creation = await applyFix(createId, [createId]);
  assert.equal(creation.applied, true);
  for (const field of ['locked', 'frozen', 'off']) {
    assert.equal(layerInfo('Version_Test')[field], true);
    assert.equal(layerInfo('보존레이어')[field], false);
  }

  // 2. false도 생략과 구별해 잠금 해제·해동·켜짐을 적용한다. 색상은 유지한다.
  const changed = await plan('plan_layer_edit', {
    names: ['Version_Test', 'CURRENT', 'XREF|ROAD', '없는레이어'], locked: false, frozen: true, off: false
  });
  assert.equal(changed.layers.length, 1);
  assert.equal(changed.blocked.length, 3);
  assert.equal(layerInfo('Version_Test').locked, true);
  const changeId = changed.option.id;
  assert.equal(fixCard(await loadFix(changeId)).kind, 'change');
  const change = await applyFix(changeId, [changeId]);
  assert.equal(change.applied, true);
  assert.deepEqual(change.editedLayers, ['Version_Test']);
  assert.equal(layerInfo('Version_Test').color, 3);
  assert.equal(layerInfo('Version_Test').locked, false);
  assert.equal(layerInfo('Version_Test').frozen, true);
  assert.equal(layerInfo('Version_Test').off, false);
  await undoOperation(change.operationId, [changeId]);
  assert.equal(layerInfo('Version_Test').locked, true);
  assert.equal(layerInfo('Version_Test').off, true);

  const thaw = await plan('plan_layer_edit', { names: ['Version_Test'], frozen: false });
  assert.equal((await applyFix(thaw.option.id, [thaw.option.id])).applied, true);
  assert.equal(layerInfo('Version_Test').frozen, false);
  assert.equal(layerInfo('Version_Test').locked, true, 'omitted lock state preserved');
  const unchanged = await plan('plan_layer_edit', { names: ['Version_Test'], frozen: false });
  assert.equal(unchanged.option, null);
  const empty = await client.callTool({ name: 'plan_layer_edit', arguments: { names: ['Version_Test'] } });
  assert.equal(empty.isError, true);
  const recolor = await plan('plan_layer_edit', { names: ['Version_Test'], color: 2 });
  assert.equal((await applyFix(recolor.option.id, [recolor.option.id])).applied, true);
  assert.equal(layerInfo('Version_Test').color, 2);
  assert.equal(layerInfo('Version_Test').off, true);

  // 3. 처음에는 객체 포함 여부를 질문한다. 재계획과 새 계획에 대한 동의가 있어야 실제 삭제한다.
  const blocked = await plan('plan_layer_delete', { names: ['NETWORK'] });
  assert.equal(blocked.option, null);
  assert.equal(blocked.blocked[0].objectCount, 4);
  assert.match(blocked.note, /ask whether to include/);
  assert.equal(layerEntities('C-PIPE').length, 2);
  const removal = await plan('plan_layer_delete', { names: ['NETWORK'], deleteObjects: true });
  assert.equal(removal.layers[0].byType.Network, 1);
  assert.equal(removal.layers[0].byType.Structure, 1);
  assert.equal(removal.layers[0].byType.PipeLabel, 1);
  assert.ok(removal.layers[0].effects.some(effect => effect.includes('다른 레이어')));
  assert.match(removal.option.summary, /객체 4개 포함/);
  const removeId = removal.option.id;
  assert.ok(fixCard(await loadFix(removeId)).labels.some(label => label.includes('다른 레이어')));
  await assert.rejects(applyFix(removeId, []), /not offered/);
  const deleted = await applyFix(removeId, [removeId]);
  assert.equal(deleted.applied, true);
  assert.equal(deleted.deletedObjects, 4);
  assert.equal(layerInfo('NETWORK'), undefined);
  assert.ok(layerInfo('C-PIPE'), 'related layer itself is preserved');
  assert.equal(layerEntities('C-PIPE').length, 0);
  await undoOperation(deleted.operationId, [removeId]);
  assert.ok(layerInfo('NETWORK'));
  assert.equal(layerEntities('C-PIPE').length, 2, 'undo restores cross-layer objects and labels');
  await assert.rejects(applyFix(removeId, [removeId], 'repeat-delete', deleted.operationId), /새로 요청/);

  // 중복된 종속 객체는 한 번만 센다. 여러 레이어 삭제도 한 작업으로 되돌린다.
  const batch = await plan('plan_layer_delete', { names: ['NETWORK', 'C-PIPE'], deleteObjects: true });
  assert.match(batch.option.summary, /객체 4개 포함/);
  const batchResult = await applyFix(batch.option.id, [batch.option.id]);
  assert.equal(batchResult.applied, true);
  assert.equal(batchResult.deletedObjects, 4);
  await undoOperation(batchResult.operationId, [batch.option.id]);
  assert.ok(layerInfo('NETWORK') && layerInfo('C-PIPE'));

  // 기본·현재·외부참조·설정 참조는 객체 포함 동의로도 보호를 우회할 수 없다.
  const protectedPlan = await plan('plan_layer_delete', {
    names: ['0', 'Defpoints', 'CURRENT', 'XREF|ROAD', 'STYLE-ONLY'], deleteObjects: true
  });
  assert.equal(protectedPlan.option, null);
  assert.equal(protectedPlan.blocked.length, 5);
  const block = await plan('plan_layer_delete', { names: ['BLOCK-ONLY', 'LAYOUT-ONLY'], deleteObjects: true });
  assert.ok(block.layers[0].effects.some(effect => effect.includes('모든 배치')));

  // 리비전 검사와 별개로 실제 삭제 객체 목록도 다시 검사해, 변경된 대상은 일부도 지우지 않는다.
  const stale = await plan('plan_layer_delete', { names: ['NETWORK'], deleteObjects: true });
  addLayerEntity({ handle: 'FF', type: 'Line', layer: 'NETWORK' });
  const refused = await applyFix(stale.option.id, [stale.option.id]);
  assert.equal(refused.applied, false);
  assert.ok(layerInfo('NETWORK'));
  assert.equal(layerEntities('C-PIPE').length, 2);
  console.log('layer-state: passed locked creation, edit/thaw/undo, occupied deletion, network effects, guards and stale lists');
}
finally {
  await client.close();
  await new Promise(resolve => bridge.close(resolve));
  assert.equal(dirname(resolve(temp)), resolve(tmpdir()), 'cleanup stays in the temporary directory');
  await rm(temp, { recursive: true, force: true });
}
