// 관리자 번호 메뉴: 문제 사례 분류 → 수정 요청서 → 완료 표시를 번호 입력만으로 끝까지 해 본다.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
  const keys = ["2", "2", "1", "레이어 삭제 기능 추가", "1", "5", "", "4", "5", "1", "0.1.9", "", "0"];
  const result = spawnSync(process.execPath, ["build/admin/console.js"], {
    input: keys.join("\n") + "\n", encoding: "utf8", timeout: 60000, windowsHide: true,
    env: { ...process.env, MY_CIVIL3D_DATA_DIR: data, MY_CIVIL3D_DRIVE_DIR: drive, MY_CIVIL3D_SYNC: "off" }
  });
  const out = result.stdout;
  assert.equal(result.status, 0, result.stderr + out);
  assert.match(out, /문제 사례 분류 전 2건, 할 일 0건/);
  assert.match(out, /레이어 삭제기능 필요/, "사례를 고르면 사용자 의견이 보여야 한다");
  assert.match(out, /2번을 할 일\(코드\)로 분류했습니다/);
  assert.match(out, /1번을 버렸습니다/);
  assert.match(out, /할 일 사례 1건으로 수정 요청서를 만들었습니다/);

  const file = /\/fix-cases (.+\.md)/.exec(out)?.[1];
  assert.ok(file && existsSync(file), "수정 요청서 파일이 있어야 한다");
  assert.match(readFileSync(file, "utf8"), /레이어 지워줘/);
  assert.match(out, /1번을 완료로 표시했습니다\(0\.1\.9에서 고침\)/);

  const cases = Object.values(JSON.parse(readFileSync(join(data, "admin", "cases.json"), "utf8")));
  assert.deepEqual(cases.map(item => [item.status, item.category, item.version]).sort(),
    [["discarded", undefined, undefined], ["done", "code", "0.1.9"]]);
  console.log("admin-menu: ok");
} finally {
  rmSync(temp, { recursive: true, force: true });
}
