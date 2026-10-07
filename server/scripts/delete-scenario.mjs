// 선형 삭제 흐름: plan_delete(미리 보기·계획) → 동의 → apply_drawing_change(삭제) → 되돌리기.
// 실제 도면 대신 가짜 Civil 3D(fixtures/fake-civil.mjs)를 쓴다.
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startFakeCivil, bumpRevision, failMethod, setDrawing } from './fixtures/fake-civil.mjs';

const temporary = await mkdtemp(join(tmpdir(), 'my-civil3d-delete-'));
const connection = join(temporary, 'connection.json');
const env = { ...process.env, MY_CIVIL3D_CONNECTION_FILE: connection, MY_CIVIL3D_DATA_DIR: temporary,
  MY_CIVIL3D_SYNC: 'off', MY_CIVIL3D_MCP_PROFILE: 'palette', MY_CIVIL3D_REQUEST_ID: 'delete-test' };
const bridge = await startFakeCivil(connection);

// 팔레트 AI처럼 MCP 서버를 띄운다(offered: 앞서 보여 준 계획 id).
// (request: 팔레트 질문마다 새 요청 id가 붙는다. 같은 계획을 다시 만들면 새 id가 생긴다.)
async function palette(offered = '', request = 'delete-test') {
  const client = new Client({ name: 'delete-scenario', version: '0.1.0' });
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

try {
  // 1) 계획: 도면은 그대로
  const planner = await palette();
  const plan = await call(planner, 'plan_delete', { alignments: ['본선', '없는선형'] });
  assert.equal(plan.error, false, JSON.stringify(plan.data));
  assert.deepEqual(plan.data.delete.map(item => item.name), ['본선']);
  assert.equal(plan.data.delete[0].profiles, 2);
  assert.equal(plan.data.notFound.length, 1);
  assert.match(plan.data.option.summary, /선형 1개 삭제 \(종단 2개, 종단 뷰 1개도 함께\)/);
  assert.equal((await call(planner, 'list_alignments', {})).data.totalCount ?? 2, 2, 'planning deletes nothing');
  const id = plan.data.option.id;

  // 보여 주지 않은 계획은 적용되지 않는다
  const refused = await call(planner, 'apply_drawing_change', { fixId: id });
  assert.equal(refused.error, true);
  await planner.close();

  // 2) 동의 → 삭제
  const applier = await palette(id);
  const applied = await call(applier, 'apply_drawing_change', { fixId: id });
  assert.equal(applied.error, false, JSON.stringify(applied.data));
  assert.equal(applied.data.applied, true);
  assert.deepEqual(applied.data.deleted.map(item => item.name), ['본선']);
  const listed = await call(applier, 'list_alignments', {});
  assert.ok(!JSON.stringify(listed.data).includes('본선'), 'the alignment is gone');

  // 같은 계획을 다시 적용하지 않는다
  assert.equal((await call(applier, 'apply_drawing_change', { fixId: id })).data.applied ?? false, false);
  await applier.close();

  // 3) 되돌리기
  process.env.MY_CIVIL3D_DATA_DIR = temporary;
  process.env.MY_CIVIL3D_CONNECTION_FILE = connection;
  const { undoOperation, applyFix } = await import('../build/changes/applyChange.js');
  // 대화 권한·도면 전환 거절은 원래 도면과 적용 기록을 보존한다.
  await assert.rejects(undoOperation(applied.data.operationId, []), /does not belong/);
  setDrawing('other-drawing');
  await assert.rejects(undoOperation(applied.data.operationId, [id]), /drawing mismatch/);
  setDrawing('fake-drawing-1');
  const undone = await undoOperation(applied.data.operationId, [id]);
  assert.equal(undone.state, 'undone');
  assert.equal((await undoOperation(applied.data.operationId, [id])).state, 'undone', 'repeated undo is idempotent');
  const { usedFix, operationStatus } = await import('../build/changes/operations.js');
  const reapplied = await applyFix(id, [id], 'delete-reapply', applied.data.operationId);
  assert.equal(reapplied.applied, true);
  await assert.rejects(undoOperation(applied.data.operationId, [id]), /superseded/);
  assert.equal((await usedFix(id)).operationId, reapplied.operationId, 'old card must not overwrite latest usage');
  // 실제로 복구됐지만 응답을 잃은 경우: unknown으로 저장하고 영수증 조회로 회복한다.
  failMethod('after.undo', 'undo response lost');
  await assert.rejects(undoOperation(reapplied.operationId, [id]), /undo response lost/);
  assert.equal((await usedFix(id)).state, 'unknown');
  failMethod('after.undo');
  assert.equal((await operationStatus(id, [id])).state, 'undone');
  const back = await palette();
  assert.ok(JSON.stringify((await call(back, 'list_alignments', {})).data).includes('본선'), 'undo restores it');

  // 4) 지울 것이 없으면 계획 id도 없다
  const nothing = await call(back, 'plan_delete', { alignments: ['없는선형'] });
  assert.equal(nothing.data.option, null);

  // 5) 코리더가 쓰는 선형: 코리더가 연관 객체로 보이고 함께 지우는 계획이 된다
  const ramp = await call(back, 'plan_delete', { alignments: ['A램프'] });
  assert.equal(ramp.error, false, JSON.stringify(ramp.data));
  assert.equal(ramp.data.delete[0].corridors[0].name, 'A램프 코리더');
  assert.match(ramp.data.option.summary, /선형 1개, 코리더 1개 삭제/);
  const { loadFix } = await import('../build/changes/changeStore.js');
  const { cancelFix, fixCard } = await import('../build/changes/operations.js');
  const card = fixCard(await loadFix(ramp.data.option.id));
  assert.equal(card.kind, 'delete');
  assert.ok(card.labels.some(label => /선형 A램프 — 함께 삭제: 코리더 A램프 코리더/.test(label) && /코리더 서피스 A램프 상면/.test(label)), card.labels.join('\n'));
  await back.close();

  // [취소]를 누른 계획은 동의해도 적용되지 않는다
  await cancelFix(ramp.data.option.id, [ramp.data.option.id]);
  const cancelledRun = await palette(ramp.data.option.id);
  const cancelled = await call(cancelledRun, 'apply_drawing_change', { fixId: ramp.data.option.id });
  assert.equal(cancelled.error, true, JSON.stringify(cancelled.data));
  assert.ok(JSON.stringify((await call(cancelledRun, 'list_alignments', {})).data).includes('A램프'), 'cancel keeps it');
  assert.equal(cancelled.data.guide.kind, 'fix_cancelled');
  await cancelledRun.close();
  const replanner = await palette('', 'delete-test-2');
  const again = await call(replanner, 'plan_delete', { alignments: ['A램프'] });
  assert.notEqual(again.data.option.id, ramp.data.option.id);
  await replanner.close();

  // 새 계획에 [진행]: 코리더와 선형이 함께 지워진다
  const proceed = await palette(again.data.option.id);
  const done = await call(proceed, 'apply_drawing_change', { fixId: again.data.option.id });
  assert.equal(done.error, false, JSON.stringify(done.data));
  assert.deepEqual(done.data.deleted.map(item => item.kind).sort(), ['alignment', 'corridor']);
  assert.equal(done.data.corridors, 1);
  await proceed.close();
  const restored = await undoOperation(done.data.operationId, [again.data.option.id]);
  assert.equal(restored.state, 'undone');
  const inspector = await palette('', 'delete-inspect');
  const restoredPlan = await call(inspector, 'plan_delete', { alignments: ['A램프'] });
  assert.equal(restoredPlan.data.delete[0].corridors[0].name, 'A램프 코리더', 'corridor is restored with alignment');
  await inspector.close();
  const finalApply = await applyFix(again.data.option.id, [again.data.option.id], 'delete-final', done.data.operationId);
  assert.equal(finalApply.applied, true);
  bumpRevision();
  await assert.rejects(undoOperation(finalApply.operationId, [again.data.option.id]), /undo conflict/);
  assert.equal((await usedFix(again.data.option.id)).state, 'applied', 'later edit refusal must preserve applied state');

  console.log('delete scenario passed: plan, consent, delete, undo, reapply, old-card refusal, lost undo response, drawing/ownership guards, corridor restoration, later-edit refusal, cancel');
} finally {
  await new Promise(resolve => bridge.close(resolve));
}
