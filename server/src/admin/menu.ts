// 관리자실행.bat의 번호 메뉴. 명령어를 외우지 않고 번호로 고른다.
// 안쪽은 팔레트와 같은 /검토·/중앙 명령을 그대로 부른다(centralCommands.ts).
// 메뉴 번호가 아닌 입력("/검토 사례 3", "1 승인" 등)은 예전처럼 명령으로 넘긴다.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { centralCommand } from "../workflows/centralCommands.js";
import { loadAdminConfig } from "./adminConfig.js";
import { adminStore } from "./adminStore.js";
import { problemCases, reviewItems } from "./review.js";

// ask: 한 줄 입력을 받는다. 입력이 끝나면(창을 닫거나 테스트 입력이 끝나면) undefined.
export type Ask = (prompt: string) => Promise<string | undefined>;
// run: 명령과 10분 자동 가져오기가 겹치지 않게 한 줄로 세운다.
export type Run = <T>(fn: () => Promise<T>) => Promise<T>;
type Io = { ask: Ask; run: Run; print: (text: string) => void; sync: () => Promise<string>; openFiles: boolean };

const CONVERSATION = "admin-console";
const OLD_NAMES: Record<string, string> = { 사용자: "/중앙 사용자", 검토: "/검토", 보고: "/검토 보고", 상태: "/중앙" };
const MAIN_MENU = [
  "",
  "1. 새 데이터 가져오기",
  "2. 문제 사례(👎·되돌림·실패) 보기·분류",
  "3. 지식 후보 검토(승인/반려)",
  "4. 수정 요청서 만들기 (Claude Code에 넘길 파일)",
  "5. 고친 사례 완료 표시 (새 버전 배포 후)",
  "6. 사용자 목록",
  "7. 사용 보고서",
  "0. 종료"
].join("\n");
const CASE_MENU = [
  "이 사례를 어떻게 할까요?",
  "  1. 코드 수정 필요 (기능 추가·버그)",
  "  2. 지식 보완 (기준값·설명이 틀림)",
  "  3. AI 답변 문제",
  "  4. 기타",
  "  5. 버림 (문제 아님)",
  "  Enter: 나중에"
].join("\n");
const CASE_ACTION: Record<string, string> = { 1: "처리 코드", 2: "처리 지식", 3: "처리 AI", 4: "처리 기타", 5: "버림" };

const command = async (text: string) => await centralCommand(text, CONVERSATION) ?? "알 수 없는 명령입니다.";
const isNumber = (text: string) => /^\d+$/.test(text);

// 메뉴 위에 보여 줄 한 줄 현황.
export function summary(): string {
  const store = adminStore();
  const fresh = problemCases(store, "new", 10000).length, todo = problemCases(store, "todo", 10000).length;
  const review = reviewItems(store, loadAdminConfig()).length;
  return `사용자 ${Object.keys(store.members).length}명 · 기록 ${store.records.length}건 · ` +
    `문제 사례 분류 전 ${fresh}건, 할 일 ${todo}건 · 지식 후보 ${review}건`;
}

// 메뉴를 돌린다. 0/종료를 고르거나 입력이 끝나면 돌아온다.
export async function adminMenu(io: Io): Promise<void> {
  while (true) {
    io.print(`\n=== My Civil 3D MCP 관리자 ===\n${await io.run(async () => summary())}${MAIN_MENU}`);
    const text = (await io.ask("번호 선택> "))?.trim();
    if (text === undefined || text === "0" || text === "종료" || text === "exit") {
      return;
    }

    try {
      await choose(text, io);
    } catch (error) {
      io.print(String(error));
    }
  }
}

async function choose(text: string, io: Io): Promise<void> {
  const show = async (line: string) => io.print(await io.run(() => command(line)));
  switch (text) {
    case "":
      return;
    case "1":
    case "동기화":
    case "/중앙 동기화":
      io.print(await io.run(io.sync));
      return;
    case "2":
      return classifyCases(io);
    case "3":
      return reviewCandidates(io);
    case "4":
      return exportCases(io);
    case "5":
      return markDone(io);
    case "6":
      return show("/중앙 사용자");
    case "7":
      return show("/검토 보고");
    default:
      return show(OLD_NAMES[text] ?? text);
  }
}

// 2. 분류 전 사례를 하나씩 보고 번호로 분류한다. 분류하면 목록에서 빠지므로 매번 목록을 다시 보여 준다.
async function classifyCases(io: Io): Promise<void> {
  while (true) {
    const list = await io.run(() => command("/검토 사례"));
    io.print("\n" + list);
    if (!/^###/.test(list)) {
      return;
    }

    const pick = (await io.ask("자세히 볼 사례 번호 (Enter: 메인 메뉴)> "))?.trim();
    if (!pick || !isNumber(pick)) {
      return;
    }

    const detail = await io.run(() => command(`/검토 사례 ${pick}`));
    io.print("\n" + detail);
    if (!/^###/.test(detail)) {
      continue;
    }

    io.print("\n" + CASE_MENU);
    const action = CASE_ACTION[(await io.ask("번호 선택> "))?.trim() ?? ""];
    if (!action) {
      continue;
    }

    const note = (await io.ask("메모 (선택, Enter: 생략)> "))?.trim() ?? "";
    io.print(await io.run(() => command(`/검토 사례 ${pick} ${action}${note ? " " + note : ""}`)));
  }
}

// 3. AI가 뽑은 지식 후보를 승인하면 다음 가져오기 때 모든 PC에 나눠 준다.
async function reviewCandidates(io: Io): Promise<void> {
  while (true) {
    const list = await io.run(() => command("/검토"));
    io.print("\n" + list);
    if (!/^###/.test(list)) {
      return;
    }

    const pick = (await io.ask("검토할 번호 (Enter: 메인 메뉴)> "))?.trim();
    if (!pick || !isNumber(pick)) {
      return;
    }

    const choice = (await io.ask("1. 승인 (모든 PC에 적용)  2. 반려  Enter: 취소> "))?.trim();
    if (choice === "1") {
      io.print(await io.run(() => command(`${pick} 승인`)));
    } else if (choice === "2") {
      const reason = (await io.ask("반려 사유 (필수)> "))?.trim();
      if (reason) {
        io.print(await io.run(() => command(`${pick} 반려 ${reason}`)));
      } else {
        io.print("사유가 없어 반려하지 않았습니다.");
      }
    }
  }
}

// 4. "할 일"로 분류한 사례를 수정 요청서(.md)로 만든다. Claude Code에 그대로 넘기면 된다.
async function exportCases(io: Io): Promise<void> {
  const count = await io.run(async () => problemCases(adminStore(), "todo", 10000).length);
  if (!count) {
    io.print("할 일로 분류한 사례가 없습니다. 먼저 2번에서 사례를 분류하세요.");
    return;
  }

  const message = await io.run(() => command("/검토 사례 내보내기"));
  const file = /: (.+\.md)\n/.exec(message)?.[1];
  if (!file) {
    io.print(message);
    return;
  }

  io.print([
    `할 일 사례 ${count}건으로 수정 요청서를 만들었습니다.`,
    `  파일: ${file}`,
    "",
    "다음 순서:",
    "  1) 이 저장소에서 Claude Code를 열고 아래 한 줄을 그대로 붙여 넣습니다.",
    `     /fix-cases ${file}`,
    "  2) 고쳐지면 배포하기.bat으로 새 버전을 배포합니다.",
    "  3) 이 메뉴의 5번에서 고친 사례를 완료로 표시합니다.",
    "(질문·답 내용이 들어 있으니 팀 밖으로 보내지 마세요.)"
  ].join("\n"));
  if (io.openFiles && existsSync(file)) {
    spawn("explorer.exe", ["/select,", file], { detached: true, stdio: "ignore" }).unref();
  }
}

// 5. 새 버전에서 고친 사례를 완료로 표시한다(그 사례의 질문·답 내용은 지워진다).
async function markDone(io: Io): Promise<void> {
  while (true) {
    const list = await io.run(() => command("/검토 사례 할일"));
    io.print("\n" + list);
    if (!/^###/.test(list)) {
      return;
    }

    const pick = (await io.ask("완료로 표시할 번호 (Enter: 메인 메뉴)> "))?.trim();
    if (!pick || !isNumber(pick)) {
      return;
    }

    const version = (await io.ask("고친 버전 (예: 0.1.9, Enter: 생략)> "))?.trim() ?? "";
    if (version && !/^\d+\.\d+\.\d+$/.test(version)) {
      io.print("버전은 0.1.9 같은 형식이어야 합니다.");
      continue;
    }

    const note = (await io.ask("메모 (선택, Enter: 생략)> "))?.trim() ?? "";
    const rest = [version, note].filter(Boolean).join(" ");
    io.print(await io.run(() => command(`/검토 사례 ${pick} 완료${rest ? " " + rest : ""}`)));
  }
}
