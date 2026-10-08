// End to end without a server: installs and the admin share one fake Google Drive folder
// (docs/데이터관리_설계.md §6). The drive stands in for "the member shared the folder and the
// admin added a shortcut": both PCs see the same folder.
// Member B logs work, has an AI-created alignment changed by a person, states a practice and
// writes everything to its send folder; admin A (with its own changes) takes it in, sees the
// shared practice and the setting both installs' changes point to, approves, and B then designs
// with that setting. Along the way: nothing private reaches the drive, the admin refuses bad and
// forged files, blocks a folder, triages problem cases, publishes a signed release, and old data
// is cleaned up.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), 'my-civil3d-drive-'));
const dirs = { drive: join(temporary, '내 드라이브'), a: join(temporary, 'install-a'), b: join(temporary, 'install-b'), c: join(temporary, 'install-c') };
for (const dir of Object.values(dirs)) await mkdir(dir, { recursive: true });

// 시험용 릴리스: 임시 키로 서명한 작은 zip(실제 릴리스 키와 다르다)
const releases = join(temporary, 'github');
await mkdir(releases);
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicKeyFile = join(temporary, 'release-public.pem');
await writeFile(publicKeyFile, publicKey.export({ type: 'spki', format: 'pem' }));
async function fakeRelease(version, signer = privateKey) {
  const name = `MyCivil3DMcp-${version}-win-x64.zip`;
  const bytes = Buffer.from(`fake release ${version} ${'x'.repeat(1000)}`);
  await writeFile(join(releases, name), bytes);
  await writeFile(join(releases, name + '.sha256'), `${createHash('sha256').update(bytes).digest('hex')}  ${name}\n`);
  await writeFile(join(releases, name + '.sig'), sign('sha256', bytes, signer).toString('base64'));
}

const { leak, blank } = await import('../build/sync/privacy.js');
assert.equal(leak('{"tool":"composite_view"}', ['SITE']), undefined, 'Latin terms match whole words only');
assert.ok(leak('{"x":"FAKE-SITE 도면"}', ['FAKE-SITE']), 'a drawing name is caught');
assert.equal(blank('부산신항에서는 D:\\설계\\a.dwg 기준', ['부산신항']), '<이름>에서는 <경로> 기준', 'Korean terms and paths are blanked');

let stepFile = 0;
async function run(dir, steps) {
  const file = join(temporary, `steps-${stepFile++}.json`);
  await writeFile(file, JSON.stringify(steps));
  const output = execFileSync(process.execPath, [join(here, 'fixtures', 'install-agent.mjs'), dir, file], { encoding: 'utf8',
    env: { ...process.env, MY_CIVIL3D_SYNC: 'off', MY_CIVIL3D_DRIVE_DIR: dirs.drive, MY_CIVIL3D_RELEASE_SOURCE: releases, MY_CIVIL3D_RELEASE_PUBLIC_KEY_FILE: publicKeyFile } });
  const results = JSON.parse(output);
  const failed = results.find(item => item.error);
  if (failed) throw new Error(failed.error);
  return results.map(item => item.result);
}
const general = content => ({ scope: 'general', title: '반지름 올림 단위', content, basis: 'user_answer', evidence: '사용자: 부산신항은 10 단위로',
  parameter: { key: 'alignment.radiusStep', value: 10 } });
const mod = (aiValue, userValue) => ({ outcome: 'modified', source: 'create', check: 'alignment.create', objectKind: 'alignment', property: 'radius',
  aiValue, userValue, ageHours: 2, conditions: { designSpeed: 40, roadClass: '집산도로', region: '도시지역', criteria: '도로구조규칙' } });
const installId = async dir => JSON.parse(await readFile(join(dir, 'install.json'), 'utf8')).installId;
const readTree = async folder => {
  let text = '';
  for (const entry of await readdir(folder, { withFileTypes: true, recursive: true }))
    if (entry.isFile()) text += await readFile(join(entry.parentPath ?? entry.path, entry.name), 'utf8');
  return text;
};

try {
  // Member B (installed from a GitHub zip: team.json carries the admin's mail) works, then sends to its own drive folder.
  await writeFile(join(dirs.b, 'team.json'), JSON.stringify({ adminEmail: 'admin@example.com' }));
  const [, , created, , , , before, synced, status] = await run(dirs.b, [
    { op: 'log', question: '부산신항_2공구 도로 반지름 알려줘', drawing: '부산신항_2공구.dwg' },
    { op: 'feedback', requestId: 'turn-0001', reason: '부산신항 반지름이 기준과 다름' },
    { op: 'createAndModify', radii: [130, 250] },
    { op: 'events', list: [mod(123, 130), mod(87, 90), mod(248, 250), mod(77, 80), mod(143, 150), mod(301, 310)] },
    { op: 'candidate', drawing: '부산신항_2공구.dwg', proposal: general('평면곡선 반지름은 10 m 단위로 올린다.') },
    { op: 'candidate', drawing: '부산신항_2공구.dwg', proposal: { scope: 'general', title: 'LH 지역', content: 'D:\\설계\\부산신항_2공구.dwg 같은 LH 사업은 도시지역이다.', basis: 'user_answer', evidence: '' } },
    { op: 'command', text: '/중앙' },
    { op: 'command', text: '/중앙 동기화' },
    { op: 'command', text: '/중앙' }
  ]);
  assert.equal(created.applied, true);
  assert.ok(created.recorded >= 1, 'the person\'s radius change was recorded');
  assert.match(before, /admin@example\.com/, 'the team mail from the installer is shown');
  assert.match(synced, /드라이브로 보낸 묶음 [1-9]/, synced);
  assert.match(status, /이 PC에 쌓인 묶음 0개/, status);
  assert.match(status, /아직 — 폴더를 관리자와 공유하세요/, status);
  assert.match(status, /admin@example\.com.*편집자/s, 'the member is told whom to share with');
  const idB = await installId(dirs.b);
  const folderB = join(dirs.drive, `MyCivil3DMcp-${idB}`);
  assert.ok(existsSync(join(folderB, 'member.json')), 'the send folder is made in the member\'s drive');

  // What reaches the drive: the question and answer with the drawing name, path and handle masked.
  const driveText = await readTree(folderB);
  for (const secret of ['부산신항', '2공구', 'D:\\', 'FAKE', '.dwg', 'C1'])
    assert.ok(!driveText.includes(secret), `the drive must not contain ${secret}: ${driveText.slice(Math.max(0, driveText.indexOf(secret) - 200), driveText.indexOf(secret) + 100)}`);
  assert.match(driveText, /"question":"<이름> 도로 반지름 알려줘"/, 'the question arrives, masked');
  assert.match(driveText, /"type":"modification"/);
  assert.match(driveText, /<경로> 같은 LH 사업은 도시지역이다/);

  // A palette command with the admin's mail is not kept as is (it would block the package).
  const [asked] = await run(dirs.c, [{ op: 'command', text: '/중앙 신청 boss@example.com' }]);
  assert.match(asked, /보내기 폴더를 만들었습니다/, asked);
  assert.match(asked, /boss@example\.com/);
  const turnsC = await readFile(join(dirs.c, 'logs', (await readdir(join(dirs.c, 'logs')))[0], 'turns.jsonl'), 'utf8');
  assert.ok(turnsC.includes('"question":"/중앙 신청 <가림>"'), 'the mail in the question is masked in the work log');
  const idC = await installId(dirs.c);

  // Admin A: its own changes and the same practice in other words; becomes admin and takes in the folders.
  const [, , madeAdmin, notYet, adminSynced, adminStatus] = await run(dirs.a, [
    { op: 'events', list: [mod(77, 80), mod(143, 150), mod(301, 310)] },
    { op: 'candidate', drawing: '다른현장.dwg', proposal: general('평면곡선 반지름은 10m 단위로 올린다') },
    { op: 'command', text: '/중앙 관리자' },
    { op: 'command', text: '/검토 사례 할일' },
    { op: 'command', text: '/중앙 동기화' },
    { op: 'command', text: '/중앙' }
  ]);
  assert.match(madeAdmin, /관리자로 정했습니다/);
  assert.match(notYet, /할 일 사례가 없습니다/);
  assert.match(adminSynced, /사용자 2명, 가져온 묶음 [1-9]/, adminSynced);
  assert.match(adminStatus, /사용자 2명/, adminStatus);
  const adminData = join(dirs.a, 'admin');
  const stored = (await readdir(join(adminData, 'records'))).map(name => join(adminData, 'records', name));
  const adminText = (await Promise.all(stored.map(file => readFile(file, 'utf8')))).join('') + await readFile(join(adminData, 'candidates.json'), 'utf8');
  for (const secret of ['부산신항', '2공구', 'D:\\', '.dwg']) assert.ok(!adminText.includes(secret), `the admin store must not contain ${secret}`);
  assert.match(adminText, /"question":"<이름> 도로 반지름 알려줘"/);
  assert.match(adminText, /"errorKind":"not_found"/);
  const received = JSON.parse(await readFile(join(folderB, 'admin', 'received.json'), 'utf8'));
  assert.ok(received.packages.length >= 1 && received.candidates.length === 2, JSON.stringify(received));

  // B sees the admin took its data and removes what was taken.
  const [bAfter] = await run(dirs.b, [{ op: 'command', text: '/중앙 동기화' }, { op: 'command', text: '/중앙' }]).then(results => results.slice(1));
  assert.match(bAfter, /관리자\(admin@example\.com\): 연결됨/, bAfter);
  const leftB = await readdir(join(folderB, 'packages'));
  assert.ok(received.packages.every(id => !leftB.includes(`${id}.json`)), 'taken packages leave the drive');
  assert.equal((await readdir(join(folderB, 'candidates'))).length, 0, 'taken candidates leave the drive');

  // Members: new ones are listed once; the footer count drops after viewing.
  const [memberList, memberAgain] = await run(dirs.a, [{ op: 'command', text: '/중앙 사용자' }, { op: 'command', text: '/중앙 사용자' }]);
  assert.match(memberList, /사용자 2명/);
  assert.equal((memberList.match(/새 사용자\*\*/g) ?? []).length, 2, memberList);
  assert.doesNotMatch(memberAgain, /새 사용자\*\*/, 'seen members are no longer new');

  // Review: the practice from two installs and the setting from both installs' changes.
  const [list, approved, rest, report] = await run(dirs.a, [
    { op: 'command', text: '/검토' },
    { op: 'command', text: '1, 2 승인' },
    { op: 'command', text: '/검토' },
    { op: 'command', text: '/검토 보고' }
  ]);
  assert.match(list, /검토할 항목 3개/, list);
  assert.match(list, /1\. \[통계 제안\]|2\. \[통계 제안\]/, list);
  assert.match(list, /2개 설치/, 'the shared practice and the setting come from two installs');
  assert.match(approved, /중앙 지식 v2/, approved);
  assert.match(rest, /검토할 항목 1개/, 'only the lone candidate is left');
  assert.match(rest, /LH 사업/);
  assert.match(report, /alignment\.radius: modified/);
  assert.match(report, /dev: [23]곳/, report);
  const [refused] = await run(dirs.a, [{ op: 'command', text: '/검토' }, { op: 'command', text: '1 반려' }]).then(results => results.slice(1));
  assert.match(refused, /사유/);
  const [rejectedOk] = await run(dirs.a, [{ op: 'command', text: '/검토' }, { op: 'command', text: '1 반려 회사마다 다름' }]).then(results => results.slice(1));
  assert.match(rejectedOk, /반려했습니다/);

  // Problem cases: list → detail → to do (code) → export a fix request → done → discard → clean up.
  const [caseList, caseDetail, caseTodo, todoList, exported, caseDone, doneList, caseDiscard, afterDiscard, cleanedCases] = await run(dirs.a, [
    { op: 'command', text: '/검토 사례' },
    { op: 'command', text: '/검토 사례 1' },
    { op: 'command', text: '/검토 사례 1 처리 코드 반지름 기준 확인 필요' },
    { op: 'command', text: '/검토 사례 할일' },
    { op: 'command', text: '/검토 사례 내보내기' },
    { op: 'command', text: '/검토 사례 1 완료 0.1.1 기준표 수정' },
    { op: 'command', text: '/검토 사례 완료' },
    { op: 'command', text: '/검토 사례 1 버림 확인 끝' },
    { op: 'command', text: '/검토 사례' },
    { op: 'command', text: '/검토 정리' }
  ]);
  assert.match(caseList, /1\. \[👎\].*<이름> 도로 반지름 알려줘/, caseList);
  assert.match(caseDetail, /\*\*질문\*\*\n<이름> 도로 반지름 알려줘/, caseDetail);
  assert.match(caseDetail, /<이름> 반지름이 기준과 다름/);
  assert.match(caseTodo, /할 일\(코드\)로 분류/);
  assert.match(todoList, /\(코드: 반지름 기준 확인 필요\)/, todoList);
  const exportFile = /수정 요청서를 만들었습니다: (.+\.md)/.exec(exported)?.[1];
  assert.ok(exportFile && existsSync(exportFile), exported);
  const request = await readFile(exportFile, 'utf8');
  assert.match(request, /# 수정 요청: 문제 사례 1건/);
  assert.match(request, /## 사례 1 · 코드 · 👎/);
  assert.match(request, /검토자 메모: 반지름 기준 확인 필요/);
  assert.match(request, /<이름> 도로 반지름 알려줘/);
  assert.match(caseDone, /0\.1\.1에서 고침.*내용은 지웠습니다/);
  assert.match(doneList, /코드 0\.1\.1/, doneList);
  assert.match(caseDiscard, /내용을 지웠습니다/);
  assert.match(afterDiscard, /분류 전 사례가 없습니다/);
  assert.match(cleanedCases, /정리했습니다\. 질문 \d+건의 내용을 지웠습니다/, cleanedCases);
  const afterScrub = (await Promise.all((await readdir(join(adminData, 'records'))).map(name => readFile(join(adminData, 'records', name), 'utf8')))).join('');
  assert.ok(!afterScrub.includes('도로 반지름 알려줘') && !afterScrub.includes('반지름이 기준과 다름'), 'a discarded case loses its content');
  assert.match(afterScrub, /"type":"turn"/, 'the numbers stay');
  assert.ok(!/"(question|answer)":/.test(afterScrub), 'after /검토 정리 no question or answer is left');

  // Bad and forged files: a package with a path, a folder copying B's install id, a candidate with a path.
  const forged = join(dirs.drive, '정리', 'MyCivil3DMcp-copy');
  await mkdir(join(forged, 'packages'), { recursive: true });
  await writeFile(join(forged, 'member.json'), JSON.stringify({ schema: 1, app: 'my-civil3d-mcp', installId: idB }));
  await writeFile(join(forged, 'packages', `${idB}-forged.json`), JSON.stringify({ schema: 1, packageId: `${idB}-forged`, installId: idB, records: [] }));
  const folderC = join(dirs.drive, `MyCivil3DMcp-${idC}`);
  await writeFile(join(folderC, 'packages', `${idC}-bad.json`), JSON.stringify({ schema: 1, packageId: `${idC}-bad`, installId: idC,
    records: [{ type: 'turn', at: '2026-10-08T10', id: 'turn-bad-0001', question: 'C:\\현장\\a.dwg 열어줘' }] }));
  await writeFile(join(folderC, 'candidates', 'C-20261008-9.json'), JSON.stringify({ localId: 'C-20261008-9', title: 't', content: 'C:\\a\\b 참고' }));
  const [badSync] = await run(dirs.a, [{ op: 'command', text: '/중앙 동기화' }]);
  assert.match(badSync, /이미 다른 폴더.*건너뜀/, badSync);
  assert.match(badSync, /비식별 검사에 걸렸습니다\(드라이브 경로\)/, badSync);
  const afterBad = (await Promise.all((await readdir(join(adminData, 'records'))).map(name => readFile(join(adminData, 'records', name), 'utf8')))).join('');
  assert.ok(!afterBad.includes('turn-bad-0001') && !afterBad.includes(`${idB}-forged`), 'nothing from bad or forged files is stored');
  assert.ok(!existsSync(join(forged, 'admin')), 'nothing is shared back to a forged folder');
  assert.ok(JSON.parse(await readFile(join(folderC, 'admin', 'received.json'), 'utf8')).packages.includes(`${idC}-bad`), 'a refused package is taken off the drive too');

  // Release: an unsigned or wrongly signed zip is refused; a signed one goes into every member folder.
  const other = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  await fakeRelease('0.0.2', other);
  const [wrongKey] = await run(dirs.a, [{ op: 'command', text: '/중앙 배포 0.0.2' }]);
  assert.match(wrongKey, /서명이 맞지 않습니다/, wrongKey);
  await fakeRelease('0.0.2');
  const [published, releaseList] = await run(dirs.a, [{ op: 'command', text: '/중앙 배포 0.0.2 필수' }, { op: 'command', text: '/중앙 배포' }]);
  assert.match(published, /0\.0\.2을\(를\) 배포했습니다\(필수 업데이트\)/, published);
  assert.match(releaseList, /지금 배포 중: 0\.0\.2 \(최소 지원 0\.0\.2\)/);
  const shared = JSON.parse(await readFile(join(folderB, 'admin', 'release.json'), 'utf8'));
  assert.deepEqual([shared.version, shared.minVersion], ['0.0.2', '0.0.2']);
  assert.ok(existsSync(join(folderB, 'admin', 'MyCivil3DMcp-0.0.2-win-x64.zip')), 'the zip is copied into the member folder');
  await fakeRelease('0.0.3');
  await run(dirs.a, [{ op: 'command', text: '/중앙 배포 0.0.3' }]);
  assert.deepEqual((await readdir(join(folderB, 'admin'))).filter(name => name.endsWith('.zip')), ['MyCivil3DMcp-0.0.3-win-x64.zip'], 'older zips are removed');

  // Block C: nothing is taken from or put into its folder any more.
  const [listed] = await run(dirs.a, [{ op: 'command', text: '/중앙 사용자' }]);
  const numberC = new RegExp(`(\\d+)\\. MyCivil3DMcp-${idC}`).exec(listed)?.[1];
  assert.ok(numberC, listed);
  const [, blocked] = await run(dirs.a, [{ op: 'command', text: '/중앙 사용자' }, { op: 'command', text: `/중앙 사용자 ${numberC} 차단` }]);
  assert.match(blocked, /차단했습니다/, blocked);
  await fakeRelease('0.0.4');
  await run(dirs.a, [{ op: 'command', text: '/중앙 배포 0.0.4' }]);
  assert.equal(JSON.parse(await readFile(join(folderC, 'admin', 'release.json'), 'utf8')).version, '0.0.3', 'a blocked folder gets nothing new');
  assert.equal(JSON.parse(await readFile(join(folderB, 'admin', 'release.json'), 'utf8')).version, '0.0.4');

  // A non-admin cannot review.
  const [notAdmin] = await run(dirs.b, [{ op: 'command', text: '/검토' }]);
  assert.match(notAdmin, /관리자 PC가 아닙니다/);

  // B receives the approved knowledge and designs with the approved step.
  await mkdir(join(dirs.b, 'logs', '2020-01-01'), { recursive: true });
  const [, rule, parameters, plan, cleaned] = await run(dirs.b, [
    { op: 'command', text: '/중앙 동기화' },
    { op: 'read', file: 'knowledge/rules/중앙_지식.md' },
    { op: 'command', text: '/설정값' },
    { op: 'plan' },
    { op: 'cleanUp' }
  ]);
  assert.match(rule, /중앙 지식 \(v2\)/, rule);
  assert.match(rule, /10 ?m 단위로 올린다/);
  assert.match(parameters, /평면곡선 반지름 올림 단위\(m\): \*\*10\*\* \(중앙 승인 중앙 v2\)/, parameters);
  assert.ok(plan.minRadii.every(radius => radius % 10 === 0), JSON.stringify(plan));
  assert.ok(plan.notes.some(note => note.includes('중앙 승인')), JSON.stringify(plan.notes));
  assert.equal(cleaned.logs, 1, 'a log folder past 30 days is removed');

  // Stop and start sending.
  const [stopped, , stoppedStatus] = await run(dirs.b, [{ op: 'command', text: '/중앙 끊기' }, { op: 'log', question: '멈춘 뒤 질문', drawing: 'x.dwg' }, { op: 'command', text: '/중앙 동기화' }]);
  assert.match(stopped, /멈췄습니다/);
  assert.match(stoppedStatus, /보낸 묶음 0개/, stoppedStatus);

  console.log('drive e2e ok: member folder, admin import (privacy, forged and bad files refused), review, approval, settings reach the member, problem cases with fix request, signed release distributed, block, retention');
} finally {
  await rm(temporary, { recursive: true, force: true });
}
