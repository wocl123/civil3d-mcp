import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { terminateTree } from "./processTree.js";

// 별도 콘솔에서 실행해야 Read-Host와 Gemini의 대화형 로그인이 입력을 받을 수 있다.
// 경로와 값은 환경변수로 전달하며 PowerShell 코드에 이어 붙이지 않는다.
const launcher = `
$ErrorActionPreference = 'Stop'
$arguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
  ('"' + $env:MY_CIVIL3D_SETUP_SCRIPT + '"'), '-Provider', $env:MY_CIVIL3D_SETUP_PROVIDER,
  '-Action', $env:MY_CIVIL3D_SETUP_ACTION)
$child = Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -ArgumentList $arguments \x60
  -WorkingDirectory ([IO.Path]::GetDirectoryName($env:MY_CIVIL3D_SETUP_STATUS)) -WindowStyle Normal -PassThru
$child.WaitForExit()
exit $child.ExitCode
`;

export async function startSetupProcess(script: string, provider: string, action: string,
  env: NodeJS.ProcessEnv): Promise<{ closed: Promise<void> }> {
  const directory = await mkdtemp(join(tmpdir(), "mycivil3d-setup-"));
  const statusFile = join(directory, "ready.json");
  const powershell = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0",
    "powershell.exe");
  const child = spawn(powershell, ["-NoProfile", "-EncodedCommand",
    Buffer.from(launcher, "utf16le").toString("base64")], {
    windowsHide: true, stdio: ["ignore", "ignore", "pipe"],
    env: { ...env, MY_CIVIL3D_SETUP_SCRIPT: script, MY_CIVIL3D_SETUP_PROVIDER: provider,
      MY_CIVIL3D_SETUP_ACTION: action, MY_CIVIL3D_SETUP_STATUS: statusFile }
  });
  let ended = false;
  let detail = "";
  child.stderr.on("data", (chunk: Buffer) => {
    detail = (detail + chunk.toString()).slice(-2000);
  });
  const closed = new Promise<void>(resolve => {
    const finish = () => {
      ended = true;
      resolve();
    };

    child.once("error", error => {
      detail = error.message;
      finish();
    });
    child.once("exit", finish);
  });

  try {
    await waitForConsole(statusFile, () => ended, () => detail);
    return { closed };
  } catch (error) {
    await terminateTree(child);
    throw error;
  } finally {
    void closed.then(() => rm(directory, { recursive: true, force: true })).catch(() => {});
  }
}

async function waitForConsole(file: string, ended: () => boolean, detail: () => string): Promise<void> {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    let status: { ready?: boolean; message?: string } | undefined;
    try {
      status = JSON.parse((await readFile(file, "utf8")).replace(/^\uFEFF/, ""));
    } catch { /* 파일이 기록되기 전에는 다음 확인을 기다린다. */ }

    if (status) {
      if (!status.ready) {
        throw new Error(status.message ?? "입력 가능한 설치·로그인 창을 열지 못했습니다.");
      }

      return;
    }

    if (ended()) {
      throw new Error("설치·로그인 창이 시작되지 않았습니다. " + detail().trim());
    }

    await delay(100);
  }

  throw new Error("설치·로그인 창의 실행을 확인하지 못했습니다. 다시 시도해 주세요.");
}
