import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { forgetCli, freshPath } from "./cliLocator.js";
import type { Provider } from "./types/Provider.js";

// When the user picks an AI that is not installed (or not signed in), the palette asks
// whether to install it (or sign in); only on [설치] / [로그인] does this open
// server/setup/setup-ai-cli.ps1 for that one AI in its own PowerShell window. The script
// installs and goes on to the sign-in, which the user completes in the browser with their
// own account.
export const SETUP_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "setup", "setup-ai-cli.ps1");

const open = new Set<Provider>();

export async function openSetupWindow(provider: Provider, action: "install" | "login"): Promise<{ opened: boolean; message: string }> {
  if (process.platform !== "win32") return { opened: false, message: "Windows에서만 지원합니다." };
  if (!existsSync(SETUP_SCRIPT)) return { opened: false, message: `설치 스크립트가 없습니다: ${SETUP_SCRIPT}` };
  if (open.has(provider)) return { opened: false, message: "이미 열린 설치·로그인 창이 있습니다. 그 창에서 계속하세요." };
  const env: Record<string, string | undefined> = { ...process.env };
  for (const key of Object.keys(env)) if (/^path$/i.test(key)) delete env[key];
  env.Path = await freshPath(provider);
  // A detached child gets its own console window on Windows.
  const child = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", SETUP_SCRIPT, "-Provider", provider, "-Action", action],
    { detached: true, stdio: "ignore", windowsHide: false, env });
  open.add(provider);
  child.on("exit", () => { open.delete(provider); forgetCli(provider); });
  child.on("error", () => open.delete(provider));
  child.unref();
  return { opened: true, message: action === "install"
    ? "설치 창을 열었습니다. 설치가 끝나면 로그인이 이어집니다. 창을 닫은 뒤 AI를 다시 눌러 주세요."
    : "로그인 창을 열었습니다. 브라우저에서 로그인하고 창을 닫은 뒤 AI를 다시 눌러 주세요." };
}
