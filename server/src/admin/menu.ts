// 관리자 번호 메뉴. 화면 이동과 작업 실행은 분리하고 기존 검토 명령을 재사용한다.
import { spawn } from "node:child_process";

export type AdminMenuIo = {
  ask: (prompt: string) => Promise<string | undefined>;
  page: (title: string, body: string, prompt: string, home?: boolean) => Promise<string | undefined>;
  notice: (text: string) => void;
  execute: (text: string) => Promise<string>;
  summary: () => Promise<string>;
  todoCount: () => Promise<number>;
  sync: () => Promise<string>;
  openFiles: boolean;
};

class ExitMenu extends Error {}

const OLD_NAMES: Record<string, string> = { 사용자: "/중앙 사용자", 검토: "/검토", 보고: "/검토 보고", 상태: "/중앙" };
const MAIN_MENU = [
  "",
  "1. 새 데이터 가져오기",
  "2. 문제 사례 보기·분류",
  "3. 지식 후보 검토 (승인/반려)",
  "4. 수정 요청서 만들기",
  "5. 고친 사례 완료·Drive 삭제",
  "6. 사용자 목록",
  "7. 사용 보고서",
  "8. 완료·버린 사례 Drive 삭제 재시도",
  "0. 종료"
].join("\n");
const CASE_MENU = [
  "이 사례를 어떻게 할까요?",
  "  1. 코드 수정 필요 (기능 추가·버그)",
  "  2. 지식 보완 (기준값·설명이 틀림)",
  "  3. AI 답변 문제",
  "  4. 기타",
  "  5. 버림 (문제 아님 · Drive 원본도 삭제)",
  "  0/Enter: 목록으로"
].join("\n");
const CASE_ACTION: Record<string, string> = { 1: "처리 코드", 2: "처리 지식", 3: "처리 AI", 4: "처리 기타", 5: "버림" };
const isNumber = (text: string) => /^\d+$/.test(text);
const isBack = (text: string | undefined) => !text || ["0", "b", "뒤로"].includes(text.toLowerCase());

async function page(io: AdminMenuIo, title: string, body: string, prompt: string, home = false) {
  const answer = (await io.page(title, body, prompt, home))?.trim();
  if (answer && ["q", "종료", "exit"].includes(answer.toLowerCase())) {
    throw new ExitMenu();
  }

  return answer;
}

async function result(io: AdminMenuIo, title: string, text: string): Promise<void> {
  await page(io, title, text, "Enter: 메인 메뉴> ");
}

async function optionalInput(io: AdminMenuIo, prompt: string): Promise<string | undefined> {
  const value = await io.ask(prompt);
  return value === "\x1b" ? undefined : value?.trim();
}

async function home(io: AdminMenuIo): Promise<string | undefined> {
  let summary = "현황을 읽지 못했습니다. 메뉴에서 다시 시도할 수 있습니다.";
  try {
    summary = await io.summary();
  } catch (error) {
    io.notice(String(error));
  }

  return page(io, "메인 메뉴", summary + MAIN_MENU, "번호 선택> ", true);
}

export async function adminMenu(io: AdminMenuIo): Promise<void> {
  try {
    while (true) {
      const text = await home(io);
      if (text === undefined || text === "0") {
        return;
      }

      try {
        await choose(text, io);
      } catch (error) {
        if (error instanceof ExitMenu) {
          throw error;
        }

        await result(io, "작업을 완료하지 못했습니다", String(error));
      }
    }
  } catch (error) {
    if (!(error instanceof ExitMenu)) {
      throw error;
    }
  }
}

async function choose(text: string, io: AdminMenuIo): Promise<void> {
  switch (text) {
    case "":
    case "b":
    case "뒤로":
      return;
    case "1":
    case "동기화":
    case "/중앙 동기화":
      return result(io, "새 데이터 가져오기", await io.sync());
    case "2":
      return classifyCases(io);
    case "3":
      return reviewCandidates(io);
    case "4":
      return exportCases(io);
    case "5":
      return markDone(io);
    case "6":
      return result(io, "사용자 목록", await io.execute("/중앙 사용자"));
    case "7":
      return result(io, "사용 보고서", await io.execute("/검토 보고"));
    case "8":
      return result(io, "완료·버린 사례 Drive 삭제", await io.execute("/검토 드라이브정리"));
    default:
      if (isNumber(text)) {
        io.notice("메뉴 번호는 1~8, 종료는 0을 입력하세요.");
        return;
      }

      return result(io, "명령 실행 결과", await io.execute(OLD_NAMES[text] ?? text));
  }
}

async function classifyCases(io: AdminMenuIo): Promise<void> {
  while (true) {
    const list = await io.execute("/검토 사례");
    if (!/^###/.test(list)) {
      io.notice(list);
      return;
    }

    const pick = await page(io, "메인 > 문제 사례", list, "사례 번호 (0/Enter: 메인 메뉴)> ");
    if (isBack(pick)) {
      return;
    }

    if (!isNumber(pick!)) {
      io.notice("사례 번호를 입력하세요.");
      continue;
    }

    const detail = await io.execute("/검토 사례 " + pick);
    if (!/^###/.test(detail)) {
      io.notice(detail);
      continue;
    }

    const choice = await page(io, "문제 사례 > " + pick + "번", detail + "\n\n" + CASE_MENU,
      "분류 번호 (0/Enter: 목록)> ");
    const action = CASE_ACTION[choice ?? ""];
    if (!action) {
      continue;
    }

    const note = await optionalInput(io, "메모 (선택, Enter: 생략 · Esc: 취소)> ");
    if (note === undefined) {
      return;
    }

    io.notice(await io.execute("/검토 사례 " + pick + " " + action + (note ? " " + note : "")));
  }
}

async function reviewCandidates(io: AdminMenuIo): Promise<void> {
  while (true) {
    const list = await io.execute("/검토");
    if (!/^###/.test(list)) {
      io.notice(list);
      return;
    }

    const pick = await page(io, "메인 > 지식 후보", list, "검토 번호 (0/Enter: 메인 메뉴)> ");
    if (isBack(pick)) {
      return;
    }

    if (!isNumber(pick!)) {
      io.notice("검토 번호를 입력하세요.");
      continue;
    }

    const choice = await page(io, "지식 후보 > " + pick + "번", list,
      "1. 승인 (모든 PC에 적용)  2. 반려  0/Enter: 취소> ");
    if (choice === "1") {
      io.notice(await io.execute(pick + " 승인"));
    } else if (choice === "2") {
      const reason = await optionalInput(io, "반려 사유 (필수 · Esc: 취소)> ");
      if (reason) {
        io.notice(await io.execute(pick + " 반려 " + reason));
      } else {
        io.notice("사유가 없어 반려하지 않았습니다.");
      }
    }
  }
}

async function exportCases(io: AdminMenuIo): Promise<void> {
  const count = await io.todoCount();
  if (!count) {
    io.notice("할 일로 분류한 사례가 없습니다. 먼저 2번에서 사례를 분류하세요.");
    return;
  }

  const message = await io.execute("/검토 사례 내보내기");
  const file = /: (.+\.md)\n/.exec(message)?.[1];
  if (!file) {
    io.notice(message);
    return;
  }

  if (io.openFiles) {
    const child = spawn("explorer.exe", ["/select,", file], { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
  }

  await result(io, "수정 요청서 만들기", [
    "할 일 사례 " + count + "건으로 수정 요청서를 만들었습니다.",
    "  파일: " + file,
    "",
    "다음 순서:",
    "  1) 이 저장소에서 Claude Code를 열고 아래 한 줄을 붙여 넣습니다.",
    "     /fix-cases " + file,
    "  2) 고쳐지면 배포하기.bat으로 새 버전을 배포합니다.",
    "  3) 이 메뉴의 5번에서 고친 사례를 완료로 표시합니다.",
    "(질문·답 내용이 들어 있으니 팀 밖으로 보내지 마세요.)"
  ].join("\n"));
}

async function markDone(io: AdminMenuIo): Promise<void> {
  while (true) {
    const list = await io.execute("/검토 사례 할일");
    if (!/^###/.test(list)) {
      io.notice(list);
      return;
    }

    const pick = await page(io, "메인 > 고친 사례 완료 표시", list, "완료 사례 번호 (0/Enter: 메인 메뉴)> ");
    if (isBack(pick)) {
      return;
    }

    if (!isNumber(pick!)) {
      io.notice("사례 번호를 입력하세요.");
      continue;
    }

    const version = await optionalInput(io, "고친 버전 (예: 0.1.9 · Enter: 생략 · Esc: 취소)> ");
    if (version === undefined) {
      return;
    }

    if (version && !/^\d+\.\d+\.\d+$/.test(version)) {
      io.notice("버전은 0.1.9 같은 형식이어야 합니다.");
      continue;
    }

    const note = await optionalInput(io, "메모 (선택, Enter: 생략 · Esc: 취소)> ");
    if (note === undefined) {
      return;
    }

    const rest = [version, note].filter(Boolean).join(" ");
    io.notice(await io.execute("/검토 사례 " + pick + " 완료" + (rest ? " " + rest : "")));
  }
}
