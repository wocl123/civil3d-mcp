// AI CLI 찾기.
// 서비스의 PATH만 믿지 않는다. 서비스는 Civil 3D의 환경을 물려받는데, 그 환경은 Civil 3D(또는 탐색기)가
// 켜진 순간의 것이라, 그 뒤에 설치했거나 사용자 전용으로 설치한 CLI가 빠져 있을 수 있다.
// 그래서 다음을 차례로 본다.
//   1) 지금 프로세스의 PATH
//   2) 레지스트리에서 새로 읽은 사용자·시스템 PATH
//   3) 공식 설치 프로그램이 쓰는 폴더
// 찾은 폴더는 CLI 프로세스의 PATH 맨 앞에 둔다(aiCli.ts). 그래야 CLI가 자기 도우미 파일도 찾는다.

import { cliPrefix, runtimeDir, withRuntimePath } from "./runtime.js";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import type { Provider } from "./types/Provider.js";

const EXTENSIONS = process.platform === "win32" ? [".exe", ".cmd", ".bat"] : [""];
const POSITIVE_TTL_MS = 60 * 1000;   // 찾은 결과를 기억하는 시간(못 찾은 결과는 기억하지 않는다)

const home = homedir();
const appData = process.env.APPDATA ?? join(home, "AppData", "Roaming");
const localAppData = process.env.LOCALAPPDATA ?? join(home, "AppData", "Local");

// 공식 설치 프로그램이 CLI를 두는 곳.
const KNOWN_DIRS: Record<Provider, string[]> = {
  claude: [join(home, ".local", "bin"), join(appData, "npm"), join(localAppData, "Programs", "claude")],
  codex: [join(appData, "npm"), join(localAppData, "Programs", "codex")],
  gemini: [join(appData, "npm")]
};

export type CliLocation = { dir: string; file: string };
const found = new Map<Provider, { location: CliLocation; at: number }>();

// 레지스트리의 PATH 값 하나를 읽는다. %USERPROFILE% 같은 변수는 Windows가 새 프로세스에 하듯 펼친다.
function regPath(key: string): Promise<string[]> {
  if (process.platform !== "win32") return Promise.resolve([]);
  return new Promise(resolve => execFile("reg.exe", ["query", key, "/v", "Path"], { windowsHide: true, timeout: 5000 }, (error, stdout) => {
    if (error) return resolve([]);
    const value = /Path\s+REG_(?:EXPAND_)?SZ\s+(.*)/i.exec(stdout)?.[1] ?? "";
    const expand = (part: string) => part.trim().replace(/%([^%]+)%/g, (_, name: string) => process.env[name] ?? `%${name}%`);
    resolve(value.split(";").map(expand).filter(Boolean));
  }));
}

// MY_CIVIL3D_CLI_DIRS(";"로 구분한 폴더들)를 주면 그 폴더만 찾는다.
// CLI를 한 곳에 모아 둔 PC나, CLI가 없는 PC를 흉내 내는 테스트에 쓴다.
const onlyDirs = () => process.env.MY_CIVIL3D_CLI_DIRS?.split(delimiter).filter(Boolean);
const windowsDir = join(process.env.SystemRoot ?? "C:\\Windows", "System32");

// 찾아볼 폴더 목록(중복 제거).
async function searchDirs(provider: Provider): Promise<string[]> {
  const only = onlyDirs();
  if (only) return process.env.MY_CIVIL3D_NODE_EXE ? [cliPrefix(provider), runtimeDir(), ...only, windowsDir] : [...only, windowsDir];

  const [user, machine] = await Promise.all([
    regPath("HKCU\\Environment"),
    regPath("HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment")
  ]);
  const current = (process.env.PATH ?? process.env.Path ?? "").split(delimiter).filter(Boolean);
  return [...new Set([cliPrefix(provider), ...current, ...user, ...machine, ...KNOWN_DIRS[provider]])];
}

// CLI 실행 파일 위치. 없으면 undefined(= 설치 안 됨).
export async function locateCli(provider: Provider): Promise<CliLocation | undefined> {
  const cached = found.get(provider);
  if (cached && Date.now() - cached.at < POSITIVE_TTL_MS && existsSync(cached.location.file)) return cached.location;

  for (const dir of await searchDirs(provider)) {
    for (const extension of EXTENSIONS) {
      const file = join(dir, provider + extension);
      if (existsSync(file)) {
        const location = { dir, file };
        found.set(provider, { location, at: Date.now() });
        return location;
      }
    }
  }
  found.delete(provider);
  return undefined;
}

// 설치 창을 닫은 뒤에는 기억해 둔 결과를 쓰지 않고 다시 찾는다.
export const forgetCli = (provider: Provider) => found.delete(provider);

// CLI 프로세스의 PATH: CLI 폴더 먼저, 그다음 새로 읽은 사용자·시스템 PATH.
export async function cliPath(provider: Provider, location: CliLocation): Promise<string> {
  return [location.dir, withRuntimePath(await searchDirs(provider))].join(delimiter);
}

// 설치 창의 PATH: 새로 읽은 사용자·시스템 PATH(npm과 새로 설치한 것이 보이게).
export async function freshPath(provider: Provider): Promise<string> {
  return withRuntimePath(await searchDirs(provider));
}
