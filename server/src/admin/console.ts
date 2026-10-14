// Standalone admin process: no Civil 3D, bridge, HTTP port, AI or GitHub needed.
import { createInterface } from "node:readline";
import { stdin, stdout } from "node:process";
import { join } from "node:path";
import { appDataDir } from "../paths.js";

process.env.MY_CIVIL3D_DATA_DIR ??= join(appDataDir(), "admin-data");
process.env.MY_CIVIL3D_ADMIN_CONSOLE = "1";
const { centralCommand } = await import("../workflows/centralCommands.js");
const { loadSettings, saveSettings } = await import("../data/settings.js");
const { runSync } = await import("../sync/syncLoop.js");

const settings = await loadSettings();
settings.drive = {
  ...settings.drive,
  enabled: true,
  admin: true,
  since: settings.drive?.since ?? new Date().toISOString()
};
if (process.env.MY_CIVIL3D_DRIVE_DIR) {
  settings.drive.root = process.env.MY_CIVIL3D_DRIVE_DIR;
}

await saveSettings(settings);

async function sync() {
  // The BAT owns a Windows mutex for this process; runSync also serializes imports.
  const result = await runSync();
  if (result.error) {
    throw new Error(result.error);
  }

  return `동기화: 사용자 ${result.members}, 기록 ${result.sent}, 후보 ${result.candidates}` +
      (result.problems?.length ? "\n" + result.problems.join("\n") : "");
}

if (process.argv.includes("--once")) {
  console.log(await sync());
} else {
  const { adminMenu } = await import("./menu.js");
  // readline의 줄 반복자는 미리 들어온 줄도 버리지 않는다(붙여 넣기·테스트 입력).
  const input = createInterface({ input: stdin, terminal: stdin.isTTY });
  const lines = input[Symbol.asyncIterator]();
  const ask = async (prompt: string) => {
    stdout.write(prompt);
    const next = await lines.next();
    return next.done ? undefined : String(next.value);
  };

  console.log("My Civil 3D MCP 관리자 · 창을 켜 두면 10분마다 새 데이터를 가져옵니다. 배포는 배포하기.bat에서 합니다.");
  try {
    console.log(await sync());
  } catch (error) {
    console.error(String(error));
  }

  // Commands and the background import share a single queue; the store is mutable.
  let queued = Promise.resolve<unknown>(undefined);
  const run = <T>(fn: () => Promise<T>): Promise<T> => {
    const task = queued.then(fn);
    queued = task.catch(() => undefined);
    return task;
  };

  // 10분마다 자동 동기화(입력한 명령과 겹치지 않게 같은 대기열로 돌린다).
  const syncInBackground = () => void run(sync).then(text => console.log(`\n[자동] ${text}`), error => console.error(String(error)));
  const clock = setInterval(syncInBackground, 10 * 60 * 1000);
  try {
    await adminMenu({ ask, run, sync, print: text => console.log(text), openFiles: stdout.isTTY === true });
  } finally {
    clearInterval(clock);
    input.close();
    await queued;
  }
}
