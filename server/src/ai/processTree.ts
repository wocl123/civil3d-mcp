import { spawn, type ChildProcess } from "node:child_process";

// Windows의 cmd.exe만 끝내면 CLI와 MCP가 남는다. 이 함수는 직접 시작한 PID의 트리만 종료한다.
export async function terminateTree(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === "win32") {
    await new Promise<void>(resolve => {
      const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      killer.once("error", () => { child.kill(); resolve(); });
      killer.once("close", () => resolve());
    });
  } else {
    try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
  }
}
