// Runs the design calculations (polyline paths, alignment plans, criteria checks,
// fixes, creation and recheck) against a fake Civil 3D and compares every result with
// fixtures/design-regression.json. A refactoring must leave the results unchanged;
// after an intended change, run with --update and review the snapshot's diff.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeCivil } from './fixtures/fake-civil.mjs';

const snapshotFile = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'design-regression.json');
const update = process.argv.includes('--update');
const temporary = await mkdtemp(join(tmpdir(), 'my-civil3d-design-'));
process.env.MY_CIVIL3D_DATA_DIR = temporary;
process.env.MY_CIVIL3D_CONNECTION_FILE = join(temporary, 'connection.json');
const bridge = await startFakeCivil(process.env.MY_CIVIL3D_CONNECTION_FILE);

const { polylinePath } = await import('../build/design/polylinePath.js');
const { planAlignmentLayout } = await import('../build/design/alignmentLayout.js');
const { checkAlignmentCriteria } = await import('../build/criteria/alignmentCriteria.js');
const { checkProfileCriteria } = await import('../build/criteria/profileCriteria.js');
const { storeFix } = await import('../build/changes/changeStore.js');
const { applyFix } = await import('../build/changes/applyChange.js');

// Values that change from run to run.
const VOLATILE = new Set(['at', 'revision', 'requestId']);
const stable = value => JSON.parse(JSON.stringify(value, (key, item) => VOLATILE.has(key) ? undefined : item));
const failure = async run => { try { await run(); return 'no error'; } catch (error) { return `error: ${error.message}`; } };

const results = {};
const record = async (name, run) => { results[name] = stable(await run()); };
const b15 = Math.tan(Math.PI / 12);
const arcPath = [{ x: 0, y: 0, bulge: 0 }, { x: 300, y: 0, bulge: b15 }, { x: 300 + 200 * Math.sin(Math.PI / 3), y: 100, bulge: 0 },
  { x: 300 + 200 * Math.sin(Math.PI / 3) + 150, y: 100 + 150 * Math.sqrt(3), bulge: 0 }];

try {
  await record('path arc', () => polylinePath(arcPath));
  await record('path arc reversed', () => polylinePath(arcPath, true));

  const road = { polyline: '2A1', uses: ['도로'] };
  await record('plan missing conditions', () => planAlignmentLayout(road));
  await record('plan 집산 도시', () => planAlignmentLayout({ ...road, uses: ['관망', '도로'], roadClass: '집산도로', region: '도시지역' }));
  await record('plan 80 도시', () => planAlignmentLayout({ ...road, designSpeed: 80, area: '도시지역' }));
  await record('plan 보조간선 산지', () => planAlignmentLayout({ ...road, roadClass: '보조간선도로', region: '지방지역(산지)', area: '지방지역(적설·한랭)' }));
  await record('plan arc 60', () => planAlignmentLayout({ polyline: '2A2', uses: ['도로'], designSpeed: 60, area: '지방지역(그 밖)' }));
  await record('plan arc reversed radii', () => planAlignmentLayout({ polyline: '2A2', uses: ['도로'], designSpeed: 60, maxSuperelevation: 6, reverse: true, radii: [{ ip: 1, radius: 100 }, { ip: 2, radius: 0 }] }));
  await record('plan overlap', () => planAlignmentLayout({ polyline: '2A5', uses: ['도로'], designSpeed: 80, area: '도시지역' }));
  await record('plan utility', () => planAlignmentLayout({ polyline: '2A4', uses: ['관망'], radii: [{ ip: 2, radius: 30 }], name: 'SD-1' }));
  await record('plan LH 단지', () => planAlignmentLayout({ ...road, criteria: 'LH_설계지침_토목', roadClass: '공동주택 단지 내 도로', region: '도시지역' }));
  await record('plan LH 집산 30', () => planAlignmentLayout({ ...road, criteria: 'LH_설계지침_토목', roadClass: '집산도로', region: '도시지역', designSpeed: 30 }));
  await record('plan LH 집산 20', () => planAlignmentLayout({ ...road, criteria: 'LH_설계지침_토목', roadClass: '집산도로', region: '도시지역', designSpeed: 20 }));
  await record('plan 고속 too fast', () => planAlignmentLayout({ ...road, roadClass: '주간선도로(고속국도)', region: '도시지역', designSpeed: 120 }));
  await record('plan closed', () => failure(() => planAlignmentLayout({ polyline: '2A3', uses: ['기타'] })));
  await record('plan no use', () => failure(() => planAlignmentLayout({ polyline: '2A1', uses: [] })));

  await record('check 본선 지방', () => checkAlignmentCriteria({ alignment: '본선', area: '지방지역(그 밖)' }));
  await record('check 본선 100 도시', () => checkAlignmentCriteria({ alignment: '본선', designSpeed: 100, maxSuperelevation: 6, area: '도시지역' }));
  await record('check 본선 class', () => checkAlignmentCriteria({ alignment: '본선', roadClass: '보조간선도로', region: '도시지역' }));
  await record('check profile', () => checkProfileCriteria({ alignment: '본선', roadFunction: '주간선·보조간선(그 밖의 도로)', terrain: '평지' }));
  await record('check profile fixes', () => checkProfileCriteria({ alignment: '본선', designSpeed: 80, roadFunction: '고속국도', terrain: '평지' }));
  await record('check profile missing', () => checkProfileCriteria({ alignment: '본선' }));

  // Creating planned alignments, the recheck that follows, and the record reused by later checks.
  const plan = await planAlignmentLayout({ ...road, roadClass: '집산도로', region: '도시지역', criteria: 'LH_설계지침_토목' });
  await storeFix(plan.option, `선형 ${plan.option.create.name}`, '선형 생성', plan.source);
  await record('create road', () => applyFix(plan.option.id, [plan.option.id]));
  await record('check created', () => checkAlignmentCriteria({ alignment: plan.option.create.name }));
  const utility = await planAlignmentLayout({ polyline: '2A4', uses: ['관망'], name: 'SD-1' });
  await storeFix(utility.option, '선형 SD-1', '선형 생성', utility.source);
  await record('create utility', () => applyFix(utility.option.id, [utility.option.id]));
  await record('check utility', () => checkAlignmentCriteria({ alignment: 'SD-1' }));
  await record('plan name taken', async () => (await planAlignmentLayout({ ...road, designSpeed: 60, area: '도시지역', name: plan.option.create.name })).option);
  await record('plan next name', async () => (await planAlignmentLayout({ ...road, designSpeed: 60, area: '도시지역' })).option.create.name);
  await record('apply not offered', () => failure(() => applyFix(plan.option.id, [])));

  if (update) {
    await writeFile(snapshotFile, JSON.stringify(results, null, 1) + '\n', 'utf8');
    console.log(`design regression snapshot written: ${Object.keys(results).length} cases`);
  } else {
    const expected = JSON.parse(await readFile(snapshotFile, 'utf8'));
    const changed = Object.keys({ ...expected, ...results }).filter(name => {
      try { assert.deepEqual(results[name], expected[name]); return false; } catch { return true; }
    });
    for (const name of changed) assert.deepEqual(results[name], expected[name], `case "${name}" changed`);
    console.log(`design regression ok: ${Object.keys(results).length} cases`);
  }
} finally {
  bridge.close();
  await rm(temporary, { recursive: true, force: true });
}
