// 관리자 창은 입력·화면만 맡는다. 저장과 가져오기는 중단 가능한 작업 프로세스에서 실행한다.
import { join } from "node:path";
import { appDataDir } from "../paths.js";
import { AdminWorker } from "./adminWorker.js";
import { AdminTerminal } from "./terminal.js";
import { longAdminJob, type AdminJob } from "./jobTypes.js";
import { parseDecision } from "../workflows/shownLists.js";

process.env.MY_CIVIL3D_DATA_DIR ??= join(appDataDir(), "admin-data");
process.env.MY_CIVIL3D_ADMIN_CONSOLE = "1";

const worker = new AdminWorker();
if (process.argv.includes("--once")) {
  try {
    console.log(await worker.request<string>({ kind: "sync" }));
  } finally {
    await worker.cancel();
  }
} else {
  const { adminMenu } = await import("./menu.js");
  const ui = new AdminTerminal();
  const interval = 10 * 60 * 1000;
  const idleDelay = 30000;
  let nextSyncAt = Date.now();
  let active: Promise<string | number> | undefined;
  let activeJob: AdminJob | undefined;
  let lastSync = "아직 가져오지 않았습니다. 1번으로 바로 가져올 수 있습니다.";

  const run = async <T extends string | number>(job: AdminJob): Promise<T> => {
    // 자동 가져오기가 이미 돌면 그 한 번의 결과만 기다린다. 중단·실패한 작업을 재전송하지 않는다.
    if (active) {
      if (job.kind === "sync" && activeJob?.kind === "sync") {
        return await active as T;
      }

      await active;
    }

    const label = job.kind === "sync" ? "새 데이터 가져오는 중" : "관리자 작업 중";
    const defaultLimit = longAdminJob(job) ? 120000 : 20000;
    const configured = longAdminJob(job)
      ? process.env.MY_CIVIL3D_ADMIN_SYNC_TIMEOUT_MS : process.env.MY_CIVIL3D_ADMIN_TIMEOUT_MS;
    const limit = Math.max(1000, Math.min(600000, Number(configured) || defaultLimit));
    ui.work(label, limit);
    const task = worker.request<T>(job);
    active = task;
    activeJob = job;
    try {
      return await task;
    } finally {
      active = undefined;
      activeJob = undefined;
      ui.work();
    }
  };

  const sync = async () => {
    nextSyncAt = Date.now() + interval;
    try {
      const text = await run<string>({ kind: "sync" });
      lastSync = text.split("\n")[0];
      return text;
    } catch (error) {
      lastSync = "가져오기를 완료하지 못했습니다. 1번으로 다시 확인하세요.";
      throw error;
    }
  };

  ui.onCancel = () => {
    void worker.cancel();
  };

  // 입력 중이거나 안쪽 메뉴를 보고 있으면 미룬다. 오래 걸리는 가져오기를 대기열에 쌓지 않는다.
  const clock = setInterval(() => {
    const idle = ui.interactive && ui.idleHome && !active && !worker.busy
      && Date.now() - ui.lastActivity >= idleDelay;
    if (!idle || Date.now() < nextSyncAt || process.env.MY_CIVIL3D_SYNC === "off") {
      return;
    }

    void sync().then(text => ui.notice("[자동] " + text), error => ui.notice(String(error)));
  }, 1000);
  clock.unref();

  try {
    await adminMenu({
      ask: prompt => ui.ask(prompt),
      page: (title, body, prompt, home) => ui.page(title, body, prompt, home),
      notice: text => ui.notice(text),
      execute: async text => {
        const result = await run<string>({ kind: "command", text });
        if (parseDecision(text)?.decision === "approved") {
          nextSyncAt = Date.now();
        }

        return result;
      },
      summary: async () => await run<string>({ kind: "summary" }) + "\n" + lastSync
        + "\n자동 가져오기: 10분마다, 메인 메뉴에서 30초 이상 입력이 없을 때",
      todoCount: () => run<number>({ kind: "todoCount" }),
      sync,
      openFiles: ui.interactive
    });
  } finally {
    clearInterval(clock);
    ui.close();
    await worker.cancel();
  }
}
