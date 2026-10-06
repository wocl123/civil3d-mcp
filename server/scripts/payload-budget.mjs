// A tool's output goes into the AI's context, so its size is a cost paid on every call.
// This calls each tool through MCP against the fake Civil 3D, prints how many characters
// it returns, and fails when one grows past its budget. Raise a budget only on purpose.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { setSelection, startFakeCivil } from './fixtures/fake-civil.mjs';

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
  capture_drawing: 300
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
  ['capture_drawing', { handles: ['2A1'] }]
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
} finally {
  await client.close();
  bridge.close();
  await rm(temporary, { recursive: true, force: true });
}
