// 관리자 작업은 한 작업 프로세스에서 순서대로 실행한다. 번호 목록도 그 프로세스가 보관한다.
import { loadSettings, saveSettings } from "../data/settings.js";
import { centralCommand } from "../workflows/centralCommands.js";
import { runSync } from "../sync/syncLoop.js";
import { adminStore } from "./adminStore.js";
import { loadAdminConfig } from "./adminConfig.js";
import { problemCases, reviewItems } from "./review.js";
import type { AdminJob } from "./jobTypes.js";

export type { AdminJob } from "./jobTypes.js";

let initialized: Promise<void> | undefined;

async function initialize(): Promise<void> {
  const settings = await loadSettings();
  const drive = {
    ...settings.drive, enabled: true, admin: true,
    since: settings.drive?.since ?? new Date().toISOString()
  };
  if (process.env.MY_CIVIL3D_DRIVE_DIR) {
    drive.root = process.env.MY_CIVIL3D_DRIVE_DIR;
  }

  if (JSON.stringify(settings.drive) !== JSON.stringify(drive)) {
    settings.drive = drive;
    await saveSettings(settings);
  }
}

export async function executeAdminJob(job: AdminJob): Promise<string | number> {
  initialized ??= initialize();
  await initialized;
  if (job.kind === "command") {
    return await centralCommand(job.text, "admin-console", { localAdminMenu: true }) ?? "알 수 없는 명령입니다.";
  }

  if (job.kind === "sync") {
    const result = await runSync();
    if (result.error) {
      throw new Error(result.error);
    }

    return `동기화: 사용자 ${result.members ?? 0}, 기록 ${result.sent}, 후보 ${result.candidates}` +
      (result.problems?.length ? "\n" + result.problems.join("\n") : "");
  }

  const store = adminStore();
  const todo = problemCases(store, "todo", 10000).length;
  if (job.kind === "todoCount") {
    return todo;
  }

  const fresh = problemCases(store, "new", 10000).length;
  const review = reviewItems(store, loadAdminConfig()).length;
  const pending = Object.values(store.cases).filter(item =>
    ["done", "discarded"].includes(item.status) && item.driveCleanup !== "done").length;
  return `사용자 ${Object.keys(store.members).length}명 · 기록 ${store.records.length}건\n` +
    `문제 사례: 분류 전 ${fresh}건 · 할 일 ${todo}건 · 지식 후보 ${review}건\nDrive 삭제 대기 ${pending}건`;
}
