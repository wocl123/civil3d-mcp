// AI CLI 설치·로그인 창 열기.
// 사용자가 설치 안 된(또는 로그인 안 된) AI를 고르면 팔레트가 먼저 "설치할까요?"("로그인할까요?")를 묻는다.
// [설치]/[로그인]을 눌렀을 때만, 그 AI 하나에 대해 server/setup/setup-ai-cli.ps1 을 새 PowerShell 창으로 연다.
// 스크립트는 설치하고 로그인까지 이어 가며, 로그인은 사용자가 브라우저에서 자기 계정으로 한다.

import { runtimeNode, cliPrefix } from "./runtime.js";
import { startSetupProcess } from "./setupProcess.js";
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
  if (process.platform !== "win32") {
    return { opened: false, message: "Windows에서만 지원합니다." };
  }

  if (!existsSync(SETUP_SCRIPT)) {
    return { opened: false, message: `설치 스크립트가 없습니다: ${SETUP_SCRIPT}` };
  }

  if (open.has(provider)) {
    return { opened: false, message: "이미 열린 설치·로그인 창이 있습니다. 그 창에서 계속하세요." };
  }

  open.add(provider);

  try {
    return await launchSetup(provider, action);
  } catch (error) {
    open.delete(provider);
    const message = error instanceof Error ? error.message : String(error);
    return { opened: false, message: "창을 열지 못했습니다: " + message };
  }
}

async function launchSetup(provider: Provider, action: "install" | "login") {
  // 창의 PATH는 레지스트리의 최신 값으로(npm과 새로 설치한 CLI가 보이게).
  const env: Record<string, string | undefined> = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^path$/i.test(key)) {
      delete env[key];
    }
  }

  env.Path = await freshPath(provider);
  env.MY_CIVIL3D_NODE_EXE = runtimeNode();
  env.MY_CIVIL3D_CLI_PREFIX = cliPrefix(provider);

  const window = await startSetupProcess(SETUP_SCRIPT, provider, action, env);
  void window.closed.then(() => {
    open.delete(provider);
    forgetCli(provider);
  });

  return {
    opened: true,
    message: action === "install"
      ? "설치 창을 열었습니다. 설치와 인증을 마친 뒤 창을 닫고 팔레트의 새로고침(↻)을 눌러 주세요."
      : "로그인 창을 열었습니다. 인증을 마친 뒤 창을 닫고 팔레트의 새로고침(↻)을 눌러 주세요."
  };
}
