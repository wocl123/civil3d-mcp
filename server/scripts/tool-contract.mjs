// The contract of the MCP tools, checked through MCP against the fake Civil 3D:
// - Output size. A tool's output goes into the AI's context, so its size is a cost paid on
//   every call. Each call prints how many characters it returns and fails past its budget.
//   Raise a budget only on purpose.
// - Failures. A failing tool returns its error with a failure guide, and every failure
//   message the code raises maps to the guide meant for it.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { setSelection, startFakeCivil } from './fixtures/fake-civil.mjs';
import { failureGuide, paletteMessage } from '../build/errors/failureGuide.js';

// Tools that fail on the fake drawing, and the guide each gets.
const FAILING_CALLS = [
  ['plan_alignment_from_polyline', { polyline: '2A3', uses: ['기타'] }, 'polyline_unusable'],
  ['apply_drawing_change', { fixId: 'fx-0000000000' }, 'fix_not_offered'],
  ['capture_drawing', { handles: ['FFFF'] }, 'unexpected']
];
// Failure messages the plug-in and the service raise, with the guide each must get.
const MESSAGES = {
  'Method not found.': 'old_plugin',
  'Civil 3D plugin connection was not found. Run NETLOAD and MYC3DCONNECTION in Civil 3D.': 'not_connected',
  'Civil 3D plugin is unavailable: connect ECONNREFUSED 127.0.0.1:48761': 'not_connected',
  'Civil 3D plugin request timed out.': 'timeout',
  'Civil 3D plugin closed the connection.': 'disconnected',
  'No active drawing.': 'no_drawing',
  'Civil 3D plugin response exceeded 2 MiB.': 'too_large',
  "Several alignments are named '본선'. Use a handle: 1A, 2B": 'ambiguous_name',
  'Fix fx-1234567890 was not offered to the user in this conversation. Show it and ask before applying.': 'fix_not_offered',
  'Fix fx-1234567890 cannot be applied: 접선장이 겹침.': 'fix_conflict',
  'alignmentArc radius 값이 400로 바뀌어 있어 적용하지 않았습니다(수정안 기준 380). 다시 검토하세요.': 'changed_since',
  '폴리라인 2A1이(가) 계획 뒤에 바뀌어 만들지 않았습니다. 다시 계획하세요.': 'changed_since',
  'alignmentSpiral.length 변경은 아직 자동으로 적용할 수 없습니다.': 'manual_only',
  '선형 선형-1이(가) 이미 있어 만들지 않았습니다.': 'name_taken',
  '닫힌 폴리라인은 선형으로 만들지 않는다. 열린 폴리라인을 쓰세요.': 'polyline_unusable',
  "Alignment '없는선형' was not found.": 'not_found',
  '제19조 최소 평면곡선 반지름 표에 설계속도 130 km/h, 최대 편경사 6% 행이 없다.': 'criteria_gap',
  'alignmentArc radius를 460로 바꾸지 못했습니다(Civil 3D 결과 380). 고정 조건이 걸린 요소일 수 있습니다.': 'civil_refused',
  'something odd': 'unexpected'
};

// Characters of text per call, for the fake drawing's sizes.
const BUDGETS = {
  get_active_drawing: 400,
  get_selection: 600,
  list_alignments: 600,
  get_alignment: 2000,
  get_alignment_section: 3000,
  get_profile: 3000,
  get_profile_section: 1200,
  list_polylines: 1000,
  check_alignment_criteria: 3000,
  check_profile_criteria: 3000,
  plan_alignment_from_polyline: 2500,
  capture_drawing: 300,
  get_drawing_summary: 1500,
  check_all_alignments: 3000
};
const CALLS = [
  ['get_active_drawing', {}],
  ['get_selection', {}],
  ['list_alignments', {}],
  ['get_alignment', { alignment: '본선' }],
  ['get_alignment_section', { alignment: '본선', section: 'elements' }],
  ['get_profile', { profile: '본선 계획선', alignment: '본선' }],
  ['get_profile_section', { profile: '본선 계획선', alignment: '본선', section: 'pvis' }],
  ['list_polylines', {}],
  ['check_alignment_criteria', { alignment: '본선', designSpeed: 100, maxSuperelevation: 6, area: '도시지역' }],
  ['check_profile_criteria', { alignment: '본선', roadFunction: '고속국도', terrain: '평지' }],
  ['plan_alignment_from_polyline', { polyline: '2A1', uses: ['도로'], roadClass: '보조간선도로', region: '지방지역(산지)', area: '지방지역(적설·한랭)' }],
  ['capture_drawing', { handles: ['2A1'] }],
  ['get_drawing_summary', {}],
  ['check_all_alignments', {}]
];

const temporary = await mkdtemp(join(tmpdir(), 'my-civil3d-payload-'));
const connection = join(temporary, 'connection.json');
const bridge = await startFakeCivil(connection);
setSelection(['2A1', 'B1']);
const client = new Client({ name: 'payload-budget', version: '0.1.0' });
try {
  await client.connect(new StdioClientTransport({
    command: process.execPath, args: [fileURLToPath(new URL('../build/index.js', import.meta.url))], stderr: 'pipe',
    env: { ...process.env, MY_CIVIL3D_CONNECTION_FILE: connection, MY_CIVIL3D_DATA_DIR: join(temporary, 'data') }
  }));
  const over = [];
  for (const [tool, args] of CALLS) {
    const result = await client.callTool({ name: tool, arguments: args });
    const text = result.content.reduce((sum, item) => sum + (item.text?.length ?? 0), 0);
    const images = result.content.filter(item => item.type === 'image').length;
    if (result.isError) over.push(`${tool} failed: ${result.content[0]?.text}`);
    else if (text > BUDGETS[tool]) over.push(`${tool} ${text} > ${BUDGETS[tool]}`);
    console.log(`${tool.padEnd(30)} ${String(text).padStart(6)} chars${images ? ` + ${images} image` : ''}`);
  }
  if (over.length) { console.error(over.join('\n')); process.exitCode = 1; }
  else console.log('payload budget ok');

  for (const [tool, args, kind] of FAILING_CALLS) {
    const result = await client.callTool({ name: tool, arguments: args });
    assert.equal(result.isError, true, `${tool} should fail`);
    assert.equal(JSON.parse(result.content[0].text).guide.kind, kind, `${tool} failure kind`);
  }
  for (const [message, kind] of Object.entries(MESSAGES)) assert.equal(failureGuide(message).kind, kind, message);
  assert.equal(failureGuide('Civil 3D plugin request timed out.').drawingChanged, 'unknown');
  assert.match(paletteMessage('claude failed. Check its account login in the CLI. (usage limit reached)'), /사용 한도/);
  assert.match(paletteMessage('codex account is not verified. Verify its login first.'), /^codex 로그인이/);
  console.log(`failure guidance ok: ${FAILING_CALLS.length} calls, ${Object.keys(MESSAGES).length} messages`);
} finally {
  await client.close();
  bridge.close();
  await rm(temporary, { recursive: true, force: true });
}
