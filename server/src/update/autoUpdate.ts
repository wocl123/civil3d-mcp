// 자동 업데이트 (docs/배포_설치.md "자동 업데이트").
//   1) 서비스가 켜지고 잠시 뒤, 그리고 6시간마다 배포 버전을 본다:
//      사용자 PC는 드라이브 보내기 폴더의 admin/release.json(관리자가 넣어 줌), 관리자 PC는 자기 보관함(/중앙 배포).
//   2) 지금보다 새 버전이면 zip을 받아 크기·SHA-256을 확인하고 data/updates 에 둔다.
//      보내기 폴더에 zip이 있으면 그것을, 없으면 관리자의 공용 배포 파일을 링크(downloadId)로 내려받는다.
//      링크로 받은 파일이 맞지 않으면(관리자가 파일을 새로 올려 링크가 바뀜 등) 보내기 폴더에 status.json을 남긴다.
//      관리자 PC는 그것을 보고 이 PC 폴더에만 zip을 따로 넣어 준다.
//   3) 업데이트 도우미(update.ps1)를 띄워 둔다. 도우미는 이 Civil 3D가 꺼지기를 기다렸다가 install.ps1로 설치한다.
//      설치 프로그램이 번들 서명을 확인하므로, 받은 파일이 공식 배포본이 아니면 설치되지 않는다.
//      도우미는 지금 설치된 번들의 설치 스크립트·공개 키를 복사해 쓴다(새 버전이 스스로를 믿게 하지 않는다).
// 개발 폴더에서 돌거나(버전 dev) 드라이브를 쓰지 않는 PC는 아무것도 하지 않는다.
// 팔레트는 /api/version 으로 상태를 받아 아래 줄에 작게 보여 준다.

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { driveSettings, type DriveSettings } from "../data/settings.js";
import { install } from "../data/install.js";
import { current, releaseFile } from "../admin/releases.js";
import { downloadUrl, findDriveRoot, memberFolderName, STATUS_FILE } from "../drive/driveFolders.js";
import { writeAtomic } from "../files.js";
import { dataDir } from "../paths.js";
import { bundleContents, isRelease, productVersion } from "../version.js";

export type UpdateState = {
  current: string;
  latest?: string;
  // dev: 개발 폴더 / offline: 드라이브 안 씀·못 찾음 / latest: 최신 / scheduled: 받아 두었고 종료 시 설치 / failed: 이번 확인 실패
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
  const drive = await driveSettings();
  if (!drive?.enabled) return state = { current: productVersion, state: "offline" };
  try {
    const release = await publishedRelease(drive);
    if (!release) return state = { current: productVersion, state: "offline" };
    if (!release.version || !release.sha256 || !release.size || !newer(release.version, productVersion))
      return state = { current: productVersion, state: "latest" };
    const required = !!release.minVersion && newer(release.minVersion, productVersion);
    if (scheduled === release.version) return state = { current: productVersion, latest: release.version, state: "scheduled", required };

    // 복사: 이미 받아 둔 파일이 맞으면 다시 받지 않는다(드라이브 파일은 여기서 내려받아진다)
    await mkdir(updatesDir(), { recursive: true });
    const zip = join(updatesDir(), `MyCivil3DMcp-${release.version}-win-x64.zip`);
    const sha = (data: Buffer) => createHash("sha256").update(data).digest("hex");
    const existing = existsSync(zip) ? await readFile(zip) : undefined;
    if (!existing || existing.length !== release.size || sha(existing) !== release.sha256) {
      const local = existsSync(release.path);
      if (!local && !release.downloadId) throw new Error("배포 파일이 아직 드라이브에 다 내려오지 않았습니다. 다음 확인 때 다시 합니다.");
      let data: Buffer | undefined;
      try {
        data = local ? await readFile(release.path) : await download(release.downloadId!, release.size);
      } catch (error) {
        await reportLinkFailure(release);
        throw error;
      }
      if (data.length !== release.size || sha(data) !== release.sha256) {
        if (!local) await reportLinkFailure(release);
        throw new Error(local ? "설치 파일이 배포 정보와 다릅니다(아직 동기화 중이거나 손상)."
          : "링크로 받은 설치 파일이 배포 정보와 다릅니다(관리자가 올리는 중이거나 링크가 바뀜). 다음 확인 때 다시 합니다.");
      }
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

// 배포 중인 버전과 그 zip 위치(보내기 폴더) 또는 링크(downloadId). 없으면 undefined.
type Published = { version?: string; sha256?: string; size?: number; minVersion?: string; path: string; downloadId?: string; publishedAt?: string; status?: string };

const LINK_GRACE_MS = 60 * 60 * 1000;   // 배포 직후에는 공용 파일이 아직 올라가는 중일 수 있다

// 관리자의 공용 배포 파일을 링크로 내려받는다("링크가 있는 모든 사용자" 공유). 크기 이상은 받지 않는다.
async function download(id: string, size?: number): Promise<Buffer> {
  let response: Response;
  try {
    response = await fetch(downloadUrl(id), { redirect: "follow", signal: AbortSignal.timeout(10 * 60 * 1000) });
  } catch (error) {
    throw new Error(`설치 파일을 링크로 받지 못했습니다(${error instanceof Error ? error.message : String(error)}).`);
  }
  if (!response.ok) throw new Error(`설치 파일을 링크로 받지 못했습니다(HTTP ${response.status}). 관리자가 링크 공유를 "링크가 있는 모든 사용자"로 했는지 확인하세요.`);
  const data = Buffer.from(await response.arrayBuffer());
  if (size && data.length > size * 2) throw new Error("링크로 받은 파일이 너무 큽니다.");
  return data;
}

// 링크로 받지 못했다고 보내기 폴더에 알린다(배포하고 1시간이 지난 뒤에만). 관리자 PC가 이 폴더에 zip을 따로 넣어 준다.
async function reportLinkFailure(release: Published): Promise<void> {
  if (!release.status || !release.downloadId || !release.version) return;
  const published = Date.parse(release.publishedAt ?? "");
  if (Number.isFinite(published) && Date.now() - published < LINK_GRACE_MS) return;
  await writeAtomic(release.status, JSON.stringify({ linkFailed: release.version, at: new Date().toISOString() }, null, 1)).catch(() => undefined);
}
async function publishedRelease(drive: DriveSettings): Promise<Published | undefined> {
  if (drive.admin) {
    const live = current();
    return live && { version: live.release.version, sha256: live.release.sha256, size: live.release.size, minVersion: live.minVersion, path: releaseFile(live.release) };
  }
  const root = findDriveRoot(drive.root);
  if (!root) return undefined;
  const member = join(root, memberFolderName((await install()).installId));
  const folder = join(member, "admin");
  try {
    const info = JSON.parse(await readFile(join(folder, "release.json"), "utf8")) as Record<string, unknown>;
    const version = typeof info.version === "string" && /^\d+\.\d+\.\d+$/.test(info.version) ? info.version : undefined;
    if (!version) return undefined;
    return { version, sha256: typeof info.sha256 === "string" ? info.sha256 : undefined, size: typeof info.size === "number" ? info.size : undefined,
      minVersion: typeof info.minVersion === "string" ? info.minVersion : undefined, path: join(folder, `MyCivil3DMcp-${version}-win-x64.zip`),
      downloadId: typeof info.downloadId === "string" && /^[\w-]{10,200}$/.test(info.downloadId) ? info.downloadId : undefined,
      publishedAt: typeof info.publishedAt === "string" ? info.publishedAt : undefined, status: join(member, STATUS_FILE) };
  } catch {
    return undefined;   // 관리자가 아직 배포 버전을 넣지 않았다
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
