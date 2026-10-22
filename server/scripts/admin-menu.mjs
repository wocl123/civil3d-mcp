// 관리자 번호 메뉴: 문제 사례 분류 → 수정 요청서 → 완료 표시를 번호 입력만으로 끝까지 해 본다.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { terminateTree } from "../build/ai/processTree.js";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const temp = mkdtempSync(join(tmpdir(), "mc-admin-menu-"));
try {
  const data = join(temp, "admin-data"), drive = join(temp, "drive");
  mkdirSync(join(data, "admin", "records"), { recursive: true });
  mkdirSync(drive);
  const row = (packageId, record) => JSON.stringify({ installId: "0123456789abcdef", packageId, receivedAt: "2026-10-12T00:00:00Z", record });
  writeFileSync(join(data, "admin", "records", "2026-10.jsonl"), [
    row("p1", { type: "turn", id: "turn-0001", at: "2026-10-12T01:00:00Z", appVersion: "0.1.8", provider: "claude", question: "레이어 지워줘", answer: "삭제 기능이 없습니다." }),
    row("p1", { type: "feedback", turnId: "turn-0001", at: "2026-10-12T01:01:00Z", rating: "bad", reason: "레이어 삭제기능 필요" }),
    row("p1", { type: "turn", id: "turn-0002", at: "2026-10-12T02:00:00Z", appVersion: "0.1.8", provider: "claude", question: "안녕", answer: "안녕하세요" }),
    row("p1", { type: "feedback", turnId: "turn-0002", at: "2026-10-12T02:01:00Z", rating: "bad", reason: "그냥" })
  ].join("\n") + "\n");

  // 2 → (최근 것이 위) 2번 자세히 → 코드 + 메모 → (남은 1건) 1번 → 버림 → 메인
  // 4 → 수정 요청서 · 5 → 1번 완료 0.1.9 → 메인 · 0 종료
  const keys = ["2", "2", "1", "레이어 삭제 기능 추가", "1", "5", "", "4", "", "5", "1", "0.1.9", "", "8", "", "0"];
  const result = spawnSync(process.execPath, ["build/admin/console.js"], {
    input: keys.join("\n") + "\n", encoding: "utf8", timeout: 60000, windowsHide: true,
    env: { ...process.env, MY_CIVIL3D_DATA_DIR: data, MY_CIVIL3D_DRIVE_DIR: drive, MY_CIVIL3D_SYNC: "off" }
  });
  const out = result.stdout;
  assert.equal(result.status, 0, result.stderr + out);
  assert.match(out, /문제 사례: 분류 전 2건 · 할 일 0건/);
  assert.match(out, /레이어 삭제기능 필요/, "사례를 고르면 사용자 의견이 보여야 한다");
  assert.match(out, /2번을 할 일\(코드\)로 분류했습니다/);
  assert.match(out, /1번을 버렸습니다/);
  assert.match(out, /할 일 사례 1건으로 수정 요청서를 만들었습니다/);

  const file = /\/fix-cases (.+\.md)/.exec(out)?.[1];
  assert.ok(file && existsSync(file), "수정 요청서 파일이 있어야 한다");
  assert.match(readFileSync(file, "utf8"), /레이어 지워줘/);
  assert.match(out, /1번을 완료로 표시했습니다\(0\.1\.9에서 고침\)/);
  assert.match(out, /완료·버린 사례 Drive 삭제/);

  const cases = Object.values(JSON.parse(readFileSync(join(data, "admin", "cases.json"), "utf8")));
  assert.deepEqual(cases.map(item => [item.status, item.category, item.version]).sort(),
    [["discarded", undefined, undefined], ["done", "code", "0.1.9"]]);

  // 조회와 승인 저장은 Drive가 끊겨도 끝나야 한다. 전달은 별도 가져오기에서 한다.
  writeFileSync(join(data, 'admin', 'candidates.json'), JSON.stringify([{
    id: 'S-1', installId: '0123456789abcdef', localId: 'C-1', title: '테스트 후보',
    content: '검토용 규칙', groupKey: 'abcde12345', receivedAt: '2026-10-15T00:00:00Z', status: 'pending'
  }]));
  writeFileSync(join(data, 'admin', 'members.json'), JSON.stringify({
    '0123456789abcdef': { installId: '0123456789abcdef', folder: '로컬 사용자', firstSeen: '2026-10-12',
      lastSeen: '2026-10-15', seen: false }
  }));
  rmSync(drive, { recursive: true, force: true });
  const offline = spawnSync(process.execPath, ['build/admin/console.js'], {
    input: ['3', '1', '1', '6', '', '0'].join('\n') + '\n', encoding: 'utf8', timeout: 15000, windowsHide: true,
    env: { ...process.env, MY_CIVIL3D_DATA_DIR: data, MY_CIVIL3D_DRIVE_DIR: drive, MY_CIVIL3D_SYNC: 'off' }
  });
  assert.equal(offline.status, 0, offline.stderr + offline.stdout);
  assert.match(offline.stdout, /승인했습니다/);
  assert.match(offline.stdout, /로컬 사용자/);
  assert.equal(JSON.parse(readFileSync(join(data, 'admin', 'official.json'), 'utf8')).items.length, 1);

  const protectedCase = { '0123456789abcdef:turn-0002': { status: 'todo', category: 'code', decidedAt: '2026-10-15' } };
  writeFileSync(join(data, 'admin', 'cases.json'), JSON.stringify(protectedCase));
  const eof = spawnSync(process.execPath, ['build/admin/console.js'], {
    input: '5\n1\n', encoding: 'utf8', timeout: 15000, windowsHide: true,
    env: { ...process.env, MY_CIVIL3D_DATA_DIR: data, MY_CIVIL3D_SYNC: 'off' }
  });
  assert.equal(eof.status, 0, eof.stderr + eof.stdout);
  assert.deepEqual(JSON.parse(readFileSync(join(data, 'admin', 'cases.json'), 'utf8')), protectedCase,
    'EOF during a form must not mark a case done');

  // 입출력이 터미널인 경우를 재현한다. 파이프 테스트만으로는 입력 글자가 안 보이는 문제를 잡지 못한다.
  const terminalSetup = join(temp, "terminal-setup.mjs");
  writeFileSync(terminalSetup, [
    'Object.defineProperty(process.stdin, "isTTY", { value: true });',
    'Object.defineProperty(process.stdout, "isTTY", { value: true });',
    'process.stdin.setRawMode = () => process.stdin;'
  ].join("\n"));
  const terminal = spawn(process.execPath, ["--import", pathToFileURL(terminalSetup).href, "build/admin/console.js"], {
    windowsHide: true,
    env: { ...process.env, MY_CIVIL3D_DATA_DIR: data, MY_CIVIL3D_DRIVE_DIR: drive, MY_CIVIL3D_SYNC: "off" }
  });
  let terminalOut = '', terminalError = '', pending = '', phase = 0;
  terminal.stderr.on('data', chunk => { terminalError += chunk.toString(); });
  terminal.stdout.on('data', chunk => {
    const text = chunk.toString();
    terminalOut += text;
    pending += text;
    const prompts = ['번호 선택> ', 'Enter: 메인 메뉴> ', '번호 선택> '];
    if (phase < prompts.length && pending.includes(prompts[phase])) {
      pending = '';
      terminal.stdin.write(['입력표시테스트\r', '\r', '0\r'][phase++]);
    }
  });
  const timeout = setTimeout(() => { void terminateTree(terminal); }, 30000);
  const status = await new Promise(resolve => terminal.on('close', resolve));
  clearTimeout(timeout);
  assert.equal(status, 0, terminalError + terminalOut);
  assert.equal(phase, 3, '터미널 프롬프트를 따라 메뉴를 이동해야 한다');
  assert.match(terminalOut, /입력표시테스트/, "터미널에서 입력한 한글이 화면에 보여야 한다");
  assert.match(terminalOut, /\x1b\[2J\x1b\[H/, '메뉴 이동은 이전 화면을 지워야 한다');
  console.log("admin-menu: ok");
} finally {
  rmSync(temp, { recursive: true, force: true });
}
