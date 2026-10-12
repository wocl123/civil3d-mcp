// Standalone admin process: no Civil 3D, bridge, HTTP port, AI or GitHub needed.
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { join } from "node:path";
import { appDataDir } from "../paths.js";

process.env.MY_CIVIL3D_DATA_DIR ??= join(appDataDir(), "admin-data");
process.env.MY_CIVIL3D_ADMIN_CONSOLE = "1";
const { centralCommand } = await import("../workflows/centralCommands.js");
const { loadSettings, saveSettings } = await import("../data/settings.js");
const { runSync } = await import("../sync/syncLoop.js");

const settings = await loadSettings();
settings.drive = { ...settings.drive, enabled: true, admin: true, since: settings.drive?.since ?? new Date().toISOString() };
if (process.env.MY_CIVIL3D_DRIVE_DIR) settings.drive.root = process.env.MY_CIVIL3D_DRIVE_DIR;
await saveSettings(settings);

async function sync() {
  // The BAT owns a Windows mutex for this process; runSync also serializes imports.
    const result = await runSync();
    if (result.error) throw new Error(result.error);
    return `동기화: 사용자 ${result.members}, 기록 ${result.sent}, 후보 ${result.candidates}` +
      (result.problems?.length ? "\n" + result.problems.join("\n") : "");
}
if (process.argv.includes("--once")) {
  console.log(await sync());
} else {
  const input = createInterface({ input: stdin, output: stdout });
  console.log("My Civil 3D MCP 관리자\n10분마다 수집합니다. 새 설치는 자동 등록되며, 사용자 목록에서 수신 상태를 확인할 수 있습니다.");
  console.log("명령: 동기화, 사용자, 검토, 보고, 1 승인, 2 반려 사유, /검토 사례, 종료\n배포는 배포하기.bat에서 실행합니다.");
  try { console.log(await sync()); } catch (error) { console.error(String(error)); }
  // Commands and the background import share a single queue; the store is mutable.
  let queued = Promise.resolve<unknown>(undefined);
  const enqueue = <T>(fn: () => Promise<T>): Promise<T> => {
    const task = queued.then(fn); queued = task.catch(() => undefined); return task;
  };
  const clock = setInterval(() => void enqueue(sync).then(console.log, error => console.error(String(error))), 10 * 60 * 1000);
  try {
    while (true) {
      const text = (await input.question("관리자> ")).trim();
      if (text === "종료" || text === "exit") break;
      if (!text) continue;
      try {
        console.log(await enqueue(async () => {
          if (text === "동기화" || text === "/중앙 동기화") return sync();
          const command = ({ 사용자: "/중앙 사용자", 검토: "/검토", 보고: "/검토 보고", 상태: "/중앙" } as Record<string,string>)[text] ?? text;
          return await centralCommand(command, "admin-console") ?? "알 수 없는 명령입니다.";
        }));
      } catch (error) { console.error(String(error)); }
    }
  } finally { clearInterval(clock); input.close(); await queued; }
}
