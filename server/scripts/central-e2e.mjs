// End to end: two installs and the central server (docs/데이터관리_설계.md).
// Install A and B each log work, have an AI-created alignment changed by a person, and
// state a practice; both send to the server; the reviewer sees the shared practice and
// the setting their changes point to, approves, and B then designs with that setting.
// Along the way: nothing private leaves either PC, secrets stay out of logs, the server
// refuses bad input, and old data is cleaned up.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), 'my-civil3d-central-'));
const dirs = { central: join(temporary, 'central'), a: join(temporary, 'install-a'), b: join(temporary, 'install-b') };
for (const dir of Object.values(dirs)) await mkdir(dir, { recursive: true });
const port = 49000 + Math.floor(Math.random() * 900);
const url = `http://127.0.0.1:${port}`;

const { leak, blank } = await import('../build/sync/privacy.js');
assert.equal(leak('{"tool":"composite_view"}', ['SITE']), undefined, 'Latin terms match whole words only');
assert.ok(leak('{"x":"FAKE-SITE 도면"}', ['FAKE-SITE']), 'a drawing name is caught');
assert.equal(blank('부산신항에서는 D:\\설계\\a.dwg 기준', ['부산신항']), '<이름>에서는 <경로> 기준', 'Korean terms and paths are blanked');

const central = spawn(process.execPath, [join(here, '..', '..', 'central', 'build', 'server.js')],
  { env: { ...process.env, CENTRAL_DATA_DIR: dirs.central, CENTRAL_PORT: String(port) }, stdio: ['ignore', 'ignore', 'pipe'] });
await new Promise((resolve, reject) => {
  central.stderr.on('data', chunk => { if (String(chunk).includes('central server:')) resolve(); });
  central.on('exit', code => reject(new Error(`central exited ${code}`)));
});
const config = JSON.parse(await readFile(join(dirs.central, 'config.json'), 'utf8'));

let stepFile = 0;
async function run(dir, steps) {
  const file = join(temporary, `steps-${stepFile++}.json`);
  await writeFile(file, JSON.stringify(steps));
  const output = execFileSync(process.execPath, [join(here, 'fixtures', 'install-agent.mjs'), dir, file], { encoding: 'utf8', env: { ...process.env, MY_CIVIL3D_SYNC: 'off' } });
  const results = JSON.parse(output);
  const failed = results.find(item => item.error);
  if (failed) throw new Error(failed.error);
  return results.map(item => item.result);
}
const api = async (path, init = {}) => {
  const response = await fetch(url + path, { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
  return { status: response.status, body: await response.json() };
};
const general = content => ({ scope: 'general', title: '반지름 올림 단위', content, basis: 'user_answer', evidence: '사용자: 부산신항은 10 단위로',
  parameter: { key: 'alignment.radiusStep', value: 10 } });
const mod = (aiValue, userValue) => ({ outcome: 'modified', source: 'create', check: 'alignment.create', objectKind: 'alignment', property: 'radius',
  aiValue, userValue, ageHours: 2, conditions: { designSpeed: 40, roadClass: '집산도로', region: '도시지역', criteria: '도로구조규칙' } });

try {
  // Install A: work, a tracked change, two candidates (one with a path and the drawing name), then connect and send.
  const [, created, , , , connected, synced, status] = await run(dirs.a, [
    { op: 'log', question: '부산신항_2공구 도로 반지름 알려줘', drawing: '부산신항_2공구.dwg' },
    { op: 'createAndModify', radii: [130, 250] },
    { op: 'events', list: [mod(123, 130), mod(87, 90), mod(248, 250)] },
    { op: 'candidate', drawing: '부산신항_2공구.dwg', proposal: general('평면곡선 반지름은 10 m 단위로 올린다.') },
    { op: 'candidate', drawing: '부산신항_2공구.dwg', proposal: { scope: 'general', title: 'LH 지역', content: 'D:\\설계\\부산신항_2공구.dwg 같은 LH 사업은 도시지역이다.', basis: 'user_answer', evidence: '' } },
    { op: 'command', text: `/중앙 연결 ${url} ${config.enrollKey}` },
    { op: 'command', text: '/중앙 동기화' },
    { op: 'command', text: '/중앙' }
  ]);
  assert.equal(created.applied, true);
  assert.ok(created.recorded >= 1, 'the person\'s radius change was recorded');
  assert.match(connected, /연결했습니다/);
  assert.match(synced, /동기화했습니다/, synced);
  assert.match(status, /보낼 묶음 0개/);

  const turns = await readFile(join(dirs.a, 'logs', (await readdir(join(dirs.a, 'logs')))[0], 'turns.jsonl'), 'utf8');
  assert.ok(!turns.includes(config.enrollKey), 'the enrol key is not in the local log');
  assert.ok(turns.includes('/중앙 연결 <가림>'));
  const settingsA = JSON.parse(await readFile(join(dirs.a, 'settings.json'), 'utf8'));
  assert.ok(!JSON.stringify(settingsA).includes(config.enrollKey), 'the enrol key is not stored');

  // What reached the server carries no question text, drawing name, path, or handle.
  const stored = (await readdir(join(dirs.central, 'records'))).map(name => join(dirs.central, 'records', name));
  const serverText = (await Promise.all(stored.map(file => readFile(file, 'utf8')))).join('') +
    await readFile(join(dirs.central, 'candidates.json'), 'utf8');
  for (const secret of ['부산신항', '2공구', '반지름 알려줘', 'D:', 'FAKE', '.dwg', 'C1', '본선'])
    assert.ok(!serverText.includes(secret), `server data must not contain ${secret}`);
  assert.match(serverText, /"type":"modification"/);
  assert.match(serverText, /<경로> 같은 LH 사업은 도시지역이다/);
  assert.match(serverText, /"errorKind":"not_found"/);

  // Install B: the same practice in other words, and its own changes.
  const [, , , syncedB] = await run(dirs.b, [
    { op: 'events', list: [mod(77, 80), mod(143, 150), mod(301, 310)] },
    { op: 'candidate', drawing: '다른현장.dwg', proposal: general('평면곡선 반지름은 10m 단위로 올린다') },
    { op: 'command', text: `/중앙 연결 ${url} ${config.enrollKey}` },
    { op: 'command', text: '/중앙 동기화' }
  ]);
  assert.match(syncedB, /동기화했습니다/, syncedB);

  // The server moved: B keeps its enrolment under a new address, and a wrong address changes nothing.
  const [wrong, moved, statusB] = await run(dirs.b, [
    { op: 'command', text: '/중앙 주소 http://127.0.0.1:1' },
    { op: 'command', text: `/중앙 주소 http://localhost:${port}` },
    { op: 'command', text: '/중앙' }
  ]);
  assert.match(wrong, /주소는 바꾸지 않았습니다/);
  assert.match(moved, /주소를 http:\/\/localhost/);
  assert.match(statusB, /localhost/);

  // The reviewer (A) sees the practice from two installs and the setting from both installs' changes.
  const review = (await api('/v1/review', { headers: { 'X-Reviewer-Key': config.reviewerKey, Authorization: `Bearer ${settingsA.central.token}` } })).body.items;
  const proposal = review.findIndex(item => item.id === 'P-alignment.radiusStep-10');
  const shared = review.findIndex(item => item.kind === 'candidate' && item.support.installs === 2);
  const lone = review.findIndex(item => item.content.includes('LH 사업'));
  assert.ok(proposal >= 0 && shared >= 0 && lone >= 0, JSON.stringify(review, null, 1));
  assert.ok(review[proposal].support.installs === 2 && review[proposal].support.cases >= 6);

  const [reviewer, list, approved, rejected, after] = await run(dirs.a, [
    { op: 'command', text: `/중앙 검토자 ${config.reviewerKey}` },
    { op: 'command', text: '/검토' },
    { op: 'command', text: `${proposal + 1}, ${shared + 1} 승인` },
    { op: 'command', text: '/검토' },
    { op: 'command', text: '/검토 보고' }
  ]);
  assert.match(reviewer, /검토자로 설정/);
  assert.match(list, /통계 제안/);
  assert.match(approved, /중앙 지식 v2/, approved);
  assert.match(rejected, /검토할 항목 1개/, 'only the lone candidate is left');
  assert.match(after, /alignment\.radius: modified/);
  const [refused] = await run(dirs.a, [{ op: 'command', text: '/검토' }, { op: 'command', text: '1 반려' }]).then(results => results.slice(1));
  assert.match(refused, /사유/);
  const [rejectedOk] = await run(dirs.a, [{ op: 'command', text: '/검토' }, { op: 'command', text: '1 반려 회사마다 다름' }]).then(results => results.slice(1));
  assert.match(rejectedOk, /반려했습니다/);

  // B receives the approved knowledge and designs with the approved step.
  await mkdir(join(dirs.b, 'logs', '2020-01-01'), { recursive: true });
  const [, rule, parameters, plan, cleaned] = await run(dirs.b, [
    { op: 'command', text: '/중앙 동기화' },
    { op: 'read', file: 'knowledge/rules/중앙_지식.md' },
    { op: 'command', text: '/설정값' },
    { op: 'plan' },
    { op: 'cleanUp' }
  ]);
  assert.match(rule, /중앙 지식 \(v2\)/);
  assert.match(rule, /10 ?m 단위로 올린다/);
  assert.match(parameters, /평면곡선 반지름 올림 단위\(m\): \*\*10\*\* \(중앙 승인 중앙 v2\)/, parameters);
  assert.ok(plan.minRadii.every(radius => radius % 10 === 0), JSON.stringify(plan));
  assert.ok(plan.notes.some(note => note.includes('중앙 승인')), JSON.stringify(plan.notes));
  assert.equal(cleaned.logs, 1, 'a log folder past 30 days is removed');

  // The server refuses unknown tokens, other installs' packages, and paths in candidates.
  const auth = { Authorization: `Bearer ${settingsA.central.token}` };
  assert.equal((await api('/v1/packages', { method: 'POST', body: '{}', headers: { Authorization: `Bearer ${'0'.repeat(64)}` } })).status, 401);
  assert.equal((await api('/v1/packages', { method: 'POST', headers: auth, body: JSON.stringify({ schema: 1, packageId: `${'1'.repeat(16)}-x`, installId: '1'.repeat(16), records: [] }) })).status, 422);
  assert.equal((await api('/v1/candidates', { method: 'POST', headers: auth, body: JSON.stringify({ candidates: [{ localId: 'C-20261006-9', title: 't', content: 'C:\\a\\b 참고' }] }) })).status, 422);
  assert.equal((await api('/v1/review', { headers: auth })).status, 403, 'review needs the reviewer key');
  const install = JSON.parse(await readFile(join(dirs.a, 'install.json'), 'utf8')).installId;
  const again = { schema: 1, packageId: `${install}-dup`, installId: install, records: [{ type: 'tool', at: '2026-10-06T10', tool: 'get_alignment', ok: true, ms: 5 }] };
  await api('/v1/packages', { method: 'POST', headers: auth, body: JSON.stringify(again) });
  assert.equal((await api('/v1/packages', { method: 'POST', headers: auth, body: JSON.stringify(again) })).body.duplicate, true, 'a package is taken once');

  console.log('central e2e ok: 2 installs, review, approval, central settings, privacy, retention');
} finally {
  central.kill();
  await rm(temporary, { recursive: true, force: true });
}
