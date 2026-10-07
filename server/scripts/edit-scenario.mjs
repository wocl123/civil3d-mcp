// 선형 속성 변경 흐름: plan_alignment_edit(계획) → 동의 → apply_drawing_change(적용) → 되돌리기.
// 실제 도면 대신 가짜 Civil 3D(fixtures/fake-civil.mjs)를 쓴다.
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startFakeCivil } from './fixtures/fake-civil.mjs';

const temporary = await mkdtemp(join(tmpdir(), 'my-civil3d-edit-'));
const connection = join(temporary, 'connection.json');
const env = { ...process.env, MY_CIVIL3D_CONNECTION_FILE: connection, MY_CIVIL3D_DATA_DIR: temporary,
  MY_CIVIL3D_SYNC: 'off', MY_CIVIL3D_MCP_PROFILE: 'palette' };
const bridge = await startFakeCivil(connection);

// 팔레트 AI처럼 MCP 서버를 띄운다(offered: 앞서 보여 준 계획 id, request: 질문마다 다른 요청 id).
async function palette(offered = '', request = 'edit-test') {
  const client = new Client({ name: 'edit-scenario', version: '0.1.0' });
  await client.connect(new StdioClientTransport({
    command: process.execPath, args: [fileURLToPath(new URL('../build/index.js', import.meta.url))], stderr: 'pipe',
    env: { ...env, MY_CIVIL3D_OFFERED_FIXES: offered, MY_CIVIL3D_REQUEST_ID: request }
  }));
  return client;
}
const call = async (client, name, args) => {
  const result = await client.callTool({ name, arguments: args });
  return { error: result.isError === true, data: JSON.parse(result.content[0].text) };
};
const names = async client => (await call(client, 'list_alignments', {})).data.items.map(item => item.name).sort();

try {
  // 1) 계획: 두 선형 이름 앞에 붙이고 레이어 바꾸기. 도면은 그대로
  const planner = await palette();
  const plan = await call(planner, 'plan_alignment_edit', { alignments: ['본선', 'A램프'], rename: { prefix: '도로-' }, layer: 'C-PIPE' });
  assert.equal(plan.error, false, JSON.stringify(plan.data));
  assert.equal(plan.data.change.length, 2);
  assert.match(plan.data.option.summary, /선형 2개 이름·레이어 변경/);
  assert.deepEqual(await names(planner), ['A램프', '본선'], 'planning changes nothing');
  const id = plan.data.option.id;

  // 없는 레이어는 계획 단계에서 거절하고 이유를 알려 준다
  const missing = await call(planner, 'plan_alignment_edit', { alignments: ['본선'], layer: '없는레이어' });
  assert.equal(missing.error, true);
  assert.match(JSON.stringify(missing.data), /도면에 없습니다/);

  // 이름이 겹치면 바꾸지 않는다
  const clash = await call(planner, 'plan_alignment_edit', { alignments: ['본선'], rename: { to: 'A램프' } });
  assert.equal(clash.data.option, null);
  assert.equal(clash.data.cannotChange.length, 1);

  // 보여 주지 않은 계획은 적용되지 않는다
  assert.equal((await call(planner, 'apply_drawing_change', { fixId: id })).error, true);
  await planner.close();

  // 2) 동의 → 적용
  const applier = await palette(id);
  const applied = await call(applier, 'apply_drawing_change', { fixId: id });
  assert.equal(applied.error, false, JSON.stringify(applied.data));
  assert.deepEqual([...applied.data.edited].sort(), ['도로-A램프', '도로-본선']);
  assert.deepEqual(await names(applier), ['도로-A램프', '도로-본선']);
  await applier.close();

  // 3) 되돌리기: 이름이 돌아온다
  process.env.MY_CIVIL3D_DATA_DIR = temporary;
  process.env.MY_CIVIL3D_CONNECTION_FILE = connection;
  const { undoOperation } = await import('../build/changes/applyChange.js');
  const undone = await undoOperation(applied.data.operationId, [id]);
  assert.equal(undone.state, 'undone');
  assert.match(undone.message, /도면이 작업 전과 같은지 확인해 주세요/);
  const back = await palette('', 'edit-check');
  assert.deepEqual(await names(back), ['A램프', '본선'], 'undo restores names');
  await back.close();

  // 4) 다시 적용 → [적용]으로 확정: 기록을 정리하고, 그 뒤에는 되돌리기도 재적용도 안 된다
  const { applyFix, confirmOperation } = await import('../build/changes/applyChange.js');
  const { usedFix } = await import('../build/changes/operations.js');
  const reapplied = await applyFix(id, [id], 'edit-reapply', applied.data.operationId);
  assert.equal(reapplied.applied, true);
  await assert.rejects(undoOperation(applied.data.operationId, [id]), /superseded/, 'an old card cannot undo the newer operation');
  assert.equal((await usedFix(id)).operationId, reapplied.operationId, 'old card must not overwrite latest usage');
  const confirmed = await confirmOperation(reapplied.operationId, [id]);
  assert.equal(confirmed.state, 'confirmed');
  assert.equal(confirmed.result, undefined, 'confirm drops the undo details');
  assert.equal((await usedFix(id)).state, 'confirmed');
  await assert.rejects(undoOperation(reapplied.operationId, [id]), /확정한 작업|되돌리기 기록이 없습니다|undone|verified/);
  await assert.rejects(applyFix(id, [id], 'edit-again', reapplied.operationId), /already applied/);
  assert.equal((await confirmOperation(reapplied.operationId, [id])).state, 'confirmed', 'confirm is idempotent');

  console.log('edit scenario passed: plan, missing layer, name clash, consent, apply, undo, reapply, old-card refusal, confirm');
} finally {
  await new Promise(resolve => bridge.close(resolve));
}
