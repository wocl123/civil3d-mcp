// 자동 업데이트 (docs/배포_설치.md "자동 업데이트").
//   1) 서비스가 켜지고 잠시 뒤, 그리고 6시간마다 중앙 서버에 배포 버전을 묻는다(설치 토큰, 인증서 고정).
//   2) 지금보다 새 버전이면 zip을 받아 크기·SHA-256을 확인하고 data/updates 에 둔다.
//   3) 업데이트 도우미(update.ps1)를 띄워 둔다. 도우미는 이 Civil 3D가 꺼지기를 기다렸다가 install.ps1로 설치한다.
//      설치 프로그램이 번들 서명을 확인하므로, 받은 파일이 공식 배포본이 아니면 설치되지 않는다.
//      도우미는 지금 설치된 번들의 설치 스크립트·공개 키를 복사해 쓴다(새 버전이 스스로를 믿게 하지 않는다).
// 개발 폴더에서 돌거나(버전 dev) 중앙 서버에 연결되지 않은 PC는 아무것도 하지 않는다.
// 팔레트는 /api/version 으로 상태를 받아 아래 줄에 작게 보여 준다.

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadSettings } from "../data/settings.js";
import { dataDir } from "../paths.js";
import { downloadRelease, getRelease } from "../sync/centralClient.js";
import { bundleContents, isRelease, productVersion } from "../version.js";

export type UpdateState = {
  current: string;
  latest?: string;
  // dev: 개발 폴더 / offline: 중앙 서버 연결 없음 / latest: 최신 / scheduled: 받아 두었고 종료 시 설치 / failed: 이번 확인 실패
  state: "dev" | "offline" | "latest" | "scheduled" | "failed";
  required?: boolean;      // 최소 지원 버전보다 낮다
  message?: string;
};

const FIRST_CHECK_MS = 20000;
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
const updatesDir = () => join(dataDir(), "updates");
const newer = (a: string, b: string) => {
  const left = a.split(".").map(Number), right = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] > right[i];
  return false;
};

let state: UpdateState = { current: productVersion, state: isRelease ? "offline" : "dev" };
let scheduled: string | undefined;
let running: Promise<UpdateState> | undefined;

export const updateState = (): UpdateState => state;

// 한 번에 하나만 확인한다.
export function checkForUpdate(): Promise<UpdateState> {
  running ??= check().finally(() => { running = undefined; });
  return running;
}

async function check(): Promise<UpdateState> {
  if (!isRelease) return state = { current: productVersion, state: "dev" };
  const central = (await loadSettings()).central;
  if (!central?.enabled) return state = { current: productVersion, state: "offline" };
  try {
    const release = await getRelease(central);
    if (release.none || !release.version || !release.sha256 || !release.size || !newer(release.version, productVersion))
      return state = { current: productVersion, state: "latest" };
    const required = !!release.minVersion && newer(release.minVersion, productVersion);
    if (scheduled === release.version) return state = { current: productVersion, latest: release.version, state: "scheduled", required };

    // 받기: 이미 받아 둔 파일이 맞으면 다시 받지 않는다
    await mkdir(updatesDir(), { recursive: true });
    const zip = join(updatesDir(), `MyCivil3DMcp-${release.version}-win-x64.zip`);
    const sha = (data: Buffer) => createHash("sha256").update(data).digest("hex");
    const existing = existsSync(zip) ? await readFile(zip) : undefined;
    if (!existing || existing.length !== release.size || sha(existing) !== release.sha256) {
      const data = await downloadRelease(central, release.version);
      if (data.length !== release.size || sha(data) !== release.sha256) throw new Error("받은 설치 파일이 서버 정보와 다릅니다.");
      await writeFile(zip, data);
    }
    await removeOldDownloads(release.version);

    await scheduleInstall(zip, release.version);
    scheduled = release.version;
    return state = { current: productVersion, latest: release.version, state: "scheduled", required };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`MyCivil3DMcp update check failed: ${message}\n`);
    return state = { ...state, current: productVersion, state: state.state === "scheduled" ? "scheduled" : "failed", message };
  }
}

// 다른 버전의 받아 둔 파일과 도우미 폴더는 지운다.
async function removeOldDownloads(keep: string): Promise<void> {
  for (const name of await readdir(updatesDir()).catch(() => [] as string[])) {
    if (name.includes(keep) || name.startsWith(`installer-${productVersion}`)) continue;
    await rm(join(updatesDir(), name), { recursive: true, force: true }).catch(() => undefined);
  }
}

// 지금 번들의 설치 스크립트를 복사해 두고 도우미를 띄운다. 도우미는 서비스와 별도로 산다:
// cmd의 start로 띄워 이 서비스의 자식 프로세스 트리에 남지 않게 한다(Civil 3D가 끌 때 서비스와 함께 꺼지지 않도록).
async function scheduleInstall(zip: string, version: string): Promise<void> {
  const source = process.env.MY_CIVIL3D_INSTALLER_DIR ?? join(bundleContents, "installer");
  const helper = join(updatesDir(), `installer-${productVersion}`);
  await mkdir(helper, { recursive: true });
  for (const name of ["install.ps1", "package-common.ps1", "release-public-key.xml", "update.ps1"]) {
    if (!existsSync(join(source, name))) throw new Error(`업데이트 도우미 파일이 없습니다: ${name}`);
    await copyFile(join(source, name), join(helper, name));
  }
  const waitPid = Number(process.env.MY_CIVIL3D_PARENT_PID ?? "0");
  if (!Number.isInteger(waitPid) || waitPid <= 0) throw new Error("기다릴 Civil 3D 프로세스를 알 수 없습니다.");
  const quote = (text: string) => `"${text}"`;
  const destination = process.env.MY_CIVIL3D_INSTALL_ROOT;   // 테스트용(기본: %APPDATA%\Autodesk\ApplicationPlugins)
  const command = ["start", '""', "powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden",
    "-File", quote(join(helper, "update.ps1")), "-Archive", quote(zip), "-WaitPid", String(waitPid), "-DataDir", quote(dataDir()),
    "-Version", version, ...(destination ? ["-DestinationRoot", quote(destination), "-SkipRunningCheck"] : [])].join(" ");
  const child = spawn("cmd.exe", ["/d", "/s", "/c", `"${command}"`], { windowsVerbatimArguments: true, windowsHide: true, stdio: "ignore", detached: true });
  child.unref();
}

export function startUpdateLoop(): void {
  if (!isRelease || process.env.MY_CIVIL3D_AUTO_UPDATE === "off") return;
  const run = () => void checkForUpdate();
  setTimeout(run, FIRST_CHECK_MS).unref();
  setInterval(run, CHECK_EVERY_MS).unref();
}
