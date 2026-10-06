// AI CLI 설치·로그인 창 열기.
// 사용자가 설치 안 된(또는 로그인 안 된) AI를 고르면 팔레트가 먼저 "설치할까요?"("로그인할까요?")를 묻는다.
// [설치]/[로그인]을 눌렀을 때만, 그 AI 하나에 대해 server/setup/setup-ai-cli.ps1 을 새 PowerShell 창으로 연다.
// 스크립트는 설치하고 로그인까지 이어 가며, 로그인은 사용자가 브라우저에서 자기 계정으로 한다.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { forgetCli, freshPath } from "./cliLocator.js";
import type { Provider } from "./types/Provider.js";

export const SETUP_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "setup", "setup-ai-cli.ps1");

// 지금 창이 열려 있는 AI(같은 AI의 창을 두 개 열지 않는다).
const open = new Set<Provider>();

export async function openSetupWindow(provider: Provider, action: "install" | "login"):
  Promise<{ opened: boolean; message: string }> {
  if (process.platform !== "win32") return { opened: false, message: "Windows에서만 지원합니다." };
  if (!existsSync(SETUP_SCRIPT)) return { opened: false, message: `설치 스크립트가 없습니다: ${SETUP_SCRIPT}` };
  if (open.has(provider)) return { opened: false, message: "이미 열린 설치·로그인 창이 있습니다. 그 창에서 계속하세요." };

  // 창의 PATH는 레지스트리의 최신 값으로(npm과 새로 설치한 CLI가 보이게).
  const env: Record<string, string | undefined> = { ...process.env };
  for (const key of Object.keys(env)) if (/^path$/i.test(key)) delete env[key];
  env.Path = await freshPath(provider);

  // detached 로 띄우면 Windows에서 자기 콘솔 창을 갖는다.
  const args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", SETUP_SCRIPT, "-Provider", provider, "-Action", action];
  const child = spawn("powershell.exe", args, { detached: true, stdio: "ignore", windowsHide: false, env });
  open.add(provider);
  child.on("exit", () => { open.delete(provider); forgetCli(provider); });
  child.on("error", () => open.delete(provider));
  child.unref();

  return {
    opened: true,
    message: action === "install"
      ? "설치 창을 열었습니다. 설치가 끝나면 로그인이 이어집니다. 창을 닫은 뒤 AI를 다시 눌러 주세요."
      : "로그인 창을 열었습니다. 브라우저에서 로그인하고 창을 닫은 뒤 AI를 다시 눌러 주세요."
  };
}
