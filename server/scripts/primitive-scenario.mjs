// MCP→계획 저장→동의/리비전 검증→적용 경로. 형상/좌표는 별도 실제 Civil 엔진 시험에서 검증한다.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startFakeCivil } from './fixtures/fake-civil.mjs';

const temp = await mkdtemp(join(tmpdir(), 'mycivil3d-primitives-'));
process.env.MY_CIVIL3D_DATA_DIR = temp;
process.env.MY_CIVIL3D_CONNECTION_FILE = join(temp, 'connection.json');
process.env.MY_CIVIL3D_SYNC = 'off';
let revision = 1, previewCalls = 0, writes = 0, zooms = [], lastPreview;
const bridge = await startFakeCivil(process.env.MY_CIVIL3D_CONNECTION_FILE, request => {
  const { method, params } = request;
  if (method === 'drawing.status') return { drawingName:'TEST.dwg',drawingId:'primitive-drawing',revision:`p-${revision}` };
  if (method === 'drawing.civil_preview') {
    previewCalls++;
    lastPreview = params;
    if (params.handles?.includes('BAD')) throw new Error('Civil 3D plugin is unavailable: read ECONNRESET');
    return { request:params,fingerprint:createHash('sha256').update(JSON.stringify(params)).digest('hex'),
      kind:params.operation.includes('delete')?'delete':params.operation.endsWith('create')?'create':'change',
      summary:params.operation,details:[JSON.stringify(params)] };
  }
  if (method === 'drawing.civil_apply') {
    assert.equal(request.context.revision,`p-${revision}`);
    writes++; revision++;
    return {operationId:params.operationId,drawingId:'primitive-drawing',revision:`p-${revision}`,state:'applied',
      operation:params.plan.request.operation,created:['AB'],modified:['AB'],deleted:['AB']};
  }
  if (method === 'drawing.zoom') { zooms.push(params); return {zoomed:true}; }
  if (method === 'dimension.list' || method === 'point.list' || method === 'drawing.cleanup' || method === 'text.list') {
    return {totalCount:0,offset:params.offset,items:[]};
  }
  if (['cogo.list','volume.get','network.catalog','network.parts','civil.styles'].includes(method)) {
    return {total:0,offset:params.offset,items:[]};
  }
});
const { openPaletteMcp } = await import('../build/mcp/paletteHost.js');
const { loadFix } = await import('../build/changes/changeStore.js');
const { answerChat } = await import('../build/workflows/paletteChat.js');
const { quickDrawingRoute } = await import('../build/workflows/quickDrawing.js');
const { errorKind } = await import('../build/sync/records.js');
const { problemCases, report } = await import('../build/admin/review.js');
const sessions = [];
async function connect(id, offeredFixes=[]) {
  const lease = await openPaletteMcp({requestId:id,offeredFixes,drawingId:'primitive-drawing'});
  const client = new Client({name:'primitive-scenario',version:'1'});
  sessions.push({lease,client});
  await client.connect(new StreamableHTTPClientTransport(new URL(lease.url),{requestInit:{headers:lease.headers}}));
  return client;
}
async function call(client,name,args={}) {
  const result = await client.callTool({name,arguments:args});
  return {error:!!result.isError,text:result.content[0]?.text,data:result.isError?undefined:JSON.parse(result.content[0].text)};
}
try {
  const planner = await connect('primitives-plan');
  const tools = (await planner.listTools()).tools;
  const names = ['list_dimensions','plan_dimension_create','plan_dimension_edit','plan_dimension_delete',
    'list_drawing_points','plan_point_create','plan_point_edit','plan_point_delete','inspect_drawing_cleanup','plan_cleanup_delete',
    'zoom_drawing','list_drawing_texts','plan_text_create','plan_text_edit','plan_text_delete','plan_geometry_create',
    'plan_geometry_delete','plan_geometry_edit','plan_pipe_network_create','plan_pipe_network_edit',
    'list_profile_views','plan_profile_view_create','plan_profile_view_edit',
    'list_civil_styles','list_cogo_points','plan_cogo_point_create','plan_cogo_point_edit',
    'get_volume_surface','plan_volume_surface_create','plan_volume_surface_edit','list_pipe_parts',
    'list_pipe_network_parts','plan_pipe_create','plan_pipe_edit','plan_structure_create','plan_structure_edit'];
  assert.ok(names.every(name=>tools.some(tool=>tool.name===name)));
  assert.deepEqual(tools.filter(tool=>!tool.annotations.readOnlyHint).map(tool=>tool.name),['apply_drawing_change']);
  const xyz = {x:0,y:0,z:0};
  const cases = [
    ['plan_dimension_create',{kind:'aligned',start:xyz,end:{x:10,y:0,z:0},location:{x:5,y:2,z:0}},'dimension.create'],
    ['plan_dimension_edit',{handles:['AB'],text:'<>'},'dimension.edit'],
    ['plan_dimension_delete',{all:true},'dimension.delete'],
    ['plan_point_create',{verticesOf:['AB']},'point.create'],
    ['plan_point_edit',{handles:['AB'],moveBy:{x:0,y:0,z:1}},'point.edit'],
    ['plan_point_delete',{handles:['AB']},'point.delete'],
    ['plan_cleanup_delete',{handles:['AB']},'cleanup.delete'],
    ['plan_surface_delete',{nameContains:'보통암'},'surface.deleteMany'],
    ['plan_text_create',{content:'검토',position:xyz},'text.create'],
    ['plan_text_edit',{all:true,layer:'0',contains:'EL',find:'EL',replace:'H',newLayer:'TXT'},'text.edit'],
    ['plan_text_delete',{all:true,layer:'0'},'text.delete'],
    ['plan_geometry_create',{kind:'rectangle',points:[xyz],width:10,height:5},'geometry.create'],
    ['plan_geometry_edit',{handles:['AB'],basePoint:xyz,scale:2,rotationDegrees:90,moveBy:xyz},'geometry.edit'],
    ['plan_pipe_network_create',{name:'배수',referenceAlignment:'본선'},'network.create'],
    ['plan_pipe_network_edit',{network:'AB',newName:'배수-변경'},'network.edit'],
    ['plan_profile_view_create',{name:'본선-종단도',alignment:'본선',position:xyz},'profileView.create'],
    ['plan_profile_view_edit',{profileView:'AB',position:xyz,description:'이동'},'profileView.edit'],
    ['plan_cogo_point_create',{points:[{number:1001,position:xyz,rawDescription:'CP'}]},'cogo.create'],
    ['plan_cogo_point_edit',{handles:['AB'],number:1002,elevation:5},'cogo.edit'],
    ['plan_volume_surface_create',{name:'토공량',baseSurface:'지반',comparisonSurface:'계획'},'volume.create'],
    ['plan_volume_surface_edit',{surface:'AB',fillFactor:1.1},'volume.edit'],
    ['plan_pipe_create',{network:'배수',name:'관-1',family:'Concrete',size:'Exact size',start:xyz,
      end:{x:10,y:0,z:-1}},'pipe.create'],
    ['plan_pipe_edit',{handle:'AB',family:'Concrete',size:'Exact larger size'},'pipe.edit'],
    ['plan_structure_create',{network:'배수',name:'맨홀-1',family:'Junction',size:'Exact size',position:xyz},'structure.create'],
    ['plan_structure_edit',{handle:'AB',rimElevation:10,sumpElevation:5},'structure.edit'],
    ['plan_geometry_delete',{handles:['AB']},'geometry.delete']
  ];
  let sequence=0;
  for (const [name,args,operation] of cases) {
    const before=writes;
    const result=await call(planner,name,args);
    assert.equal(result.error,false,result.text);
    assert.equal(writes,before,'planning cannot change drawing');
    const fix=await loadFix(result.data.option.id);
    assert.equal(fix.civil.request.operation,operation);
    assert.equal(fix.civil.kind,operation.includes('delete')?'delete':operation.endsWith('create')?'create':'change');
    assert.equal((await call(planner,'apply_drawing_change',{fixId:fix.id})).error,true,'consent required');
    const approved=await connect(`approved-${++sequence}`,[fix.id]);
    assert.equal((await call(approved,'apply_drawing_change',{fixId:fix.id})).error,false);
    assert.equal(writes,before+1);
    assert.equal((await call(approved,'apply_drawing_change',{fixId:fix.id})).error,true,'no duplicate apply');
  }
  for (const [name,args] of [
    ['list_civil_styles',{kind:'point'}],['list_cogo_points',{}],['get_volume_surface',{surface:'VOL'}],
    ['list_pipe_parts',{}],['list_pipe_network_parts',{network:'배수'}]
  ]) {
    assert.equal((await call(planner,name,args)).error,false);
  }
  assert.equal((await call(planner,'plan_cogo_point_create',{points:[{number:0,position:xyz}]})).error,true);
  assert.equal((await call(planner,'plan_volume_surface_edit',{surface:'VOL',cutFactor:-1})).error,true);
  assert.equal((await call(planner,'list_pipe_parts',{family:'family-without-list'})).error,true);

  // 모호한 요청은 직접 실행 대상으로 분류하지 않는다. 모델이 필요한 경우 기존 경로로 간다.
  for (const question of ['치수선 다 삭제하지마','치수선 다 삭제하고 저장','선택한 치수선만 다 삭제',
    '이 레이어 빼고 치수선 다 삭제','COGO 점 다 삭제','점 다 삭제','치수선 다 삭제할 수 있어?']) {
    assert.equal(quickDrawingRoute(question),undefined,question);
  }
  const fastStarted=performance.now(), beforeFast=writes;
  const quickPlan=await answerChat('claude','치수선 다 삭제',undefined,'direct-plan-conversation');
  assert.equal(quickPlan.usage.inputTokens,0,'clear plan skips unavailable AI entirely');
  assert.equal(writes,beforeFast,'direct route only previews, never deletes');
  assert.equal(quickPlan.fixes.length,1);
  const fastPlanMs=Math.round(performance.now()-fastStarted);
  const quickApplied=await answerChat('claude','고고',undefined,'direct-plan-conversation');
  assert.equal(quickApplied.usage.inputTokens,0);
  assert.equal(writes,beforeFast+1,'next explicit agreement uses guarded apply');
  const quickList=await answerChat('claude','치수선 목록',undefined,'direct-list-conversation');
  assert.equal(quickList.usage.inputTokens,0);
  assert.match(quickList.answer,/치수선 0개/);
  assert.equal(writes,beforeFast+1,'direct list cannot mutate drawing');
  // 문자 조건 레이어(filterLayer)와 바꿀 레이어(layer)가 섞이지 않는다.
  await call(planner,'plan_text_edit',{all:true,layer:'0',newLayer:'TXT',height:2});
  assert.equal(lastPreview.filterLayer,'0');
  assert.equal(lastPreview.layer,'TXT');
  await call(planner,'plan_text_delete',{all:true,layer:'0'});
  assert.equal(lastPreview.filterLayer,'0');
  assert.equal(lastPreview.layer,undefined);
  assert.equal((await call(planner,'plan_text_edit',{handles:['AB'],layer:'0',height:2})).error,true,'layer filter needs all');
  assert.equal((await call(planner,'plan_text_edit',{handles:['AB'],find:'A'})).error,true,'find needs replace');
  assert.equal((await call(planner,'plan_geometry_create',{kind:'hexagon',points:[xyz]})).error,true);
  // 줌은 화면만 바꾼다: 계획·동의·쓰기 없이 바로 실행된다.
  const writesBeforeZoom=writes, previewsBeforeZoom=previewCalls;
  assert.equal((await call(planner,'zoom_drawing',{handles:['AB']})).error,false);
  assert.equal((await call(planner,'zoom_drawing',{center:xyz,size:20})).error,false);
  assert.deepEqual(zooms.map(zoom=>Object.keys(zoom).filter(key=>key!=='operation').sort()),[['handles'],['center','size']]);
  assert.equal(writes,writesBeforeZoom,'zoom never writes');
  assert.equal(previewCalls,previewsBeforeZoom,'zoom needs no plan');
  const stale=(await call(planner,'plan_point_create',{points:[xyz]})).data.option.id;
  revision++;
  assert.equal((await call(await connect('stale-plan',[stale]),'apply_drawing_change',{fixId:stale})).error,true);
  assert.equal((await call(planner,'plan_surface_delete',{surface:'one',nameContains:'two'})).error,true);
  assert.equal((await call(planner,'plan_dimension_create',{kind:'invented',start:xyz,location:xyz})).error,true);
  assert.equal((await call(planner,'plan_point_edit',{handles:['not a handle'],position:xyz})).error,true);
  const before=previewCalls;
  const failure={handles:['BAD']};
  assert.equal((await call(planner,'plan_dimension_delete',failure)).error,true);
  assert.equal((await call(planner,'plan_dimension_delete',failure)).error,true);
  assert.equal(previewCalls,before+1,'same failed request never calls CAD twice');
  await call(await connect('new-turn-retry'),'plan_dimension_delete',failure);
  assert.equal(previewCalls,before+2,'a new user turn can retry after repair');
  assert.equal(errorKind('요청을 취소했습니다. 도면 변경 결과는 작업 카드에서 확인하세요.'),'request_cancelled');
  const cancelled={installId:'0123456789abcdef',record:{type:'turn',id:'cancelled-turn',at:'2026-10-16T00',errorKind:'request_cancelled'}};
  assert.equal(problemCases({records:[cancelled],cases:{}}).length,0,'ordinary cancellation not a failure case');
  assert.equal(problemCases({records:[cancelled,{installId:cancelled.installId,record:{type:'feedback',turnId:'cancelled-turn',
    rating:'bad',reason:'실제 문제'}}],cases:{}}).length,1,'explicit negative feedback retained');
  const summary=report({records:[{...cancelled,receivedAt:new Date().toISOString()}]}, {reportDays:7});
  assert.deepEqual(summary.failedTurns,{},'cancellation excluded from failure totals');
  assert.equal(summary.byVersion[0].failed,0,'cancellation excluded from version failure rate');
  console.log(JSON.stringify({passed:'Drawing/Civil extension MCP, direct plan/list without AI, next-turn consent, single writer and revision guards',fastPlanMs}));
} finally {
  await Promise.allSettled(sessions.map(({client})=>client.close()));
  await Promise.allSettled(sessions.map(({lease})=>lease.close()));
  await new Promise(resolve=>bridge.close(resolve));
  await rm(temp,{recursive:true,force:true,maxRetries:5,retryDelay:100});
}
