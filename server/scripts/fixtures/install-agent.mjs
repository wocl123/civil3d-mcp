// One simulated install for central-e2e.mjs: runs the given steps in its own process with its
// own data folder and fake Civil 3D, and prints each step's result as JSON.
//   node install-agent.mjs <dataDir> <steps.json>
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { bumpRevision, startFakeCivil } from './fake-civil.mjs';
import { created } from './fake-polyline.mjs';

const [dataDir, stepsFile] = process.argv.slice(2);
process.env.MY_CIVIL3D_DATA_DIR = dataDir;
process.env.MY_CIVIL3D_CONNECTION_FILE = join(dataDir, 'connection.json');
const bridge = await startFakeCivil(process.env.MY_CIVIL3D_CONNECTION_FILE);

const build = '../../build/';
const { answerChat } = await import(build + 'workflows/paletteChat.js');
const { planAlignmentLayout } = await import(build + 'design/alignmentLayout.js');
const { storeFix } = await import(build + 'changes/changeStore.js');
const { applyFix } = await import(build + 'changes/applyChange.js');
const { checkTracked } = await import(build + 'tracking/tracker.js');
const { currentDrawingScope } = await import(build + 'memory/drawingScope.js');
const { logEvent, logTurn, logTool } = await import(build + 'logs/workLog.js');
const { addCandidates } = await import(build + 'knowledge/candidateStore.js');
const { runSync } = await import(build + 'sync/syncLoop.js');
const { cleanUp } = await import(build + 'sync/retention.js');
const { addTerms } = await import(build + 'data/terms.js');

const road = { polyline: '2A1', uses: ['도로'], roadClass: '집산도로', region: '도시지역' };
const files = async folder => (await readdir(join(dataDir, folder)).catch(() => [])).sort();
const ops = {
  // A palette command, answered without an AI.
  command: async ({ text }) => (await answerChat('claude', text, undefined, 'conv-test-1')).answer,
  // A turn as the palette logs it, with the question text and drawing name that must never leave.
  log: async ({ question, drawing }) => {
    await addTerms([drawing]);
    await logTurn({ requestId: 'r1', conversation: 'c1', provider: 'claude', question, kind: 'chat', drawing, ms: 900,
      model: { model: 'sonnet', effort: 'medium' }, tools: ['get_alignment'], answer: `${drawing}의 본선은 ...`, usage: { inputTokens: 100, outputTokens: 20 } });
    await logTool({ requestId: 'r1', tool: 'get_alignment', input: `{"alignment":"${drawing} 본선"}`, ms: 40, ok: false, error: `Alignment '${drawing}' was not found.` });
    return 'logged';
  },
  // The AI creates a road alignment; a person then changes the radii; the next look records it.
  createAndModify: async ({ radii }) => {
    const plan = await planAlignmentLayout(road);
    await storeFix(plan.option, `선형 ${plan.option.create.name}`, '선형 생성', plan.source);
    const applied = await applyFix(plan.option.id, [plan.option.id]);
    const alignment = created.get(plan.option.create.name);
    radii.forEach((radius, index) => {
      for (const element of alignment.elements.filter(item => item.curveGroup === index + 1 && item.kind === 'Arc')) element.radius = radius;
    });
    bumpRevision();
    const recorded = await checkTracked(await currentDrawingScope());
    return { applied: applied.applied, aiRadii: applied.created.curves.map(curve => curve.radius), recorded };
  },
  // Modifications as other sessions would have recorded them.
  events: async ({ list }) => { for (const item of list) await logEvent({ type: 'modification', ...item }); return list.length; },
  candidate: async ({ proposal, drawing }) => addCandidates([proposal], drawing, 'claude'),
  sync: async () => runSync(),
  outbox: async () => Promise.all((await files('outbox/pending')).map(async name => readFile(join(dataDir, 'outbox/pending', name), 'utf8'))),
  blocked: async () => files('outbox/blocked'),
  read: async ({ file }) => readFile(join(dataDir, file), 'utf8').catch(() => null),
  plan: async () => {
    const plan = await planAlignmentLayout(road);
    return { radii: plan.ips.map(ip => ip.radius), minRadii: plan.ips.map(ip => ip.minRadius), notes: plan.notes };
  },
  cleanUp: async () => cleanUp()
};

const results = [];
try {
  for (const step of JSON.parse(await readFile(stepsFile, 'utf8'))) results.push({ op: step.op, result: await ops[step.op](step) });
  process.stdout.write(JSON.stringify(results));
} catch (error) {
  process.stdout.write(JSON.stringify([...results, { error: error.stack ?? String(error) }]));
} finally {
  bridge.close();
}
