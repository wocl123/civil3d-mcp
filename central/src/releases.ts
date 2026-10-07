// 배포본 보관과 배포 버전 지정 (docs/배포_설치.md).
//   <dataDir>/releases/<버전>/<zip>          받아 둔 설치본
//   <dataDir>/releases/<버전>/release.json   버전, 파일, SHA-256, 크기, 출처
//   <dataDir>/releases/current.json          지금 배포하는 버전(검토자가 지정) + 최소 지원 버전
// 받아 두기만 해서는 배포되지 않는다. 지정(publish)해야 설치 프로그램과 팔레트가 받아 간다.
// 서버가 요청마다 파일을 다시 읽으므로, 관리 명령(release.ts)으로 바꾸면 서버를 다시 켜지 않아도 된다.

import { createHash, verify } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { copyFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { dataDir } from "./config.js";
import { RELEASE_PUBLIC_KEY } from "./releaseKey.js";

export type Release = {
  version: string;
  file: string;          // releases/<버전>/ 안의 zip 이름
  sha256: string;
  size: number;
  source: "github" | "file";
  signed: boolean;       // GitHub 릴리스 서명(<zip>.sig)을 확인했는지. 설치 프로그램은 번들 안의 서명을 따로 확인한다
  tag?: string;
  addedAt: string;
};
export type Current = { version: string; minVersion?: string; publishedAt: string };

export const VERSION = /^\d+\.\d+\.\d+$/;
const ZIP_NAME = /^MyCivil3DMcp-(\d+\.\d+\.\d+)-win-x64\.zip$/;

export class ReleaseError extends Error {}

// 0.10.0 > 0.9.0 처럼 숫자로 비교한다.
export function compareVersions(a: string, b: string): number {
  const left = a.split(".").map(Number), right = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] - right[i];
  return 0;
}

const root = () => join(dataDir, "releases");
const folder = (version: string) => join(root(), version);

function readJson<T>(file: string): T | undefined {
  try { return JSON.parse(readFileSync(file, "utf8")) as T; } catch { return undefined; }
}
function writeJson(file: string, value: unknown): void {
  writeFileSync(file + ".tmp", JSON.stringify(value, null, 1), "utf8");
  renameSync(file + ".tmp", file);
}

export function zipVersion(name: string): string | undefined {
  return ZIP_NAME.exec(basename(name))?.[1];
}

export function readRelease(version: string): Release | undefined {
  if (!VERSION.test(version)) return undefined;
  const release = readJson<Release>(join(folder(version), "release.json"));
  return release && existsSync(join(folder(version), release.file)) ? release : undefined;
}

export function listReleases(): Release[] {
  if (!existsSync(root())) return [];
  return readdirSync(root()).filter(name => VERSION.test(name)).flatMap(name => readRelease(name) ?? [])
    .sort((a, b) => compareVersions(b.version, a.version));
}

// 지금 배포하는 버전. 지정한 적 없거나 파일이 없으면 undefined.
export function current(): { release: Release; minVersion?: string; publishedAt: string } | undefined {
  const state = readJson<Current>(join(root(), "current.json"));
  const release = state && readRelease(state.version);
  return release && { release, minVersion: state.minVersion, publishedAt: state.publishedAt };
}

export function publish(version: string, minVersion?: string): Current {
  if (!readRelease(version)) throw new ReleaseError(`받아 둔 ${version} 설치본이 없습니다. 먼저 fetch 또는 add로 받아 두세요.`);
  if (minVersion && (!VERSION.test(minVersion) || compareVersions(minVersion, version) > 0))
    throw new ReleaseError("최소 지원 버전은 배포 버전보다 높을 수 없습니다.");
  const state: Current = { version, ...(minVersion ? { minVersion } : {}), publishedAt: new Date().toISOString() };
  mkdirSync(root(), { recursive: true });
  writeJson(join(root(), "current.json"), state);
  return state;
}

export function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(file).on("data", chunk => hash.update(chunk)).on("error", reject).on("end", () => resolve(hash.digest("hex")));
  });
}

// zip 하나를 보관한다. expectedSha256이 있으면(같이 받은 .sha256) 맞아야 한다.
// zip 전체에 대한 서명(.sig, base64)을 공개 키로 확인한다. 서명이 없으면 allowUnsigned일 때만 받는다(시험용).
function checkSignature(zip: string, signature: string | undefined, allowUnsigned: boolean): boolean {
  if (!signature) {
    if (allowUnsigned) return false;
    throw new ReleaseError("서명(.sig)이 없는 설치본은 받지 않습니다. 시험용이면 --unsigned 를 붙이세요.");
  }
  const ok = verify("sha256", readFileSync(zip), RELEASE_PUBLIC_KEY, Buffer.from(signature.trim(), "base64"));
  if (!ok) throw new ReleaseError("설치본의 서명이 맞지 않습니다(변조되었거나 공식 배포본이 아님). 받지 않습니다.");
  return true;
}

export async function addRelease(zip: string, options: { version?: string; expectedSha256?: string; signature?: string; allowUnsigned?: boolean;
  source: Release["source"]; tag?: string }): Promise<Release> {
  const version = options.version ?? zipVersion(zip);
  if (!version || !VERSION.test(version)) throw new ReleaseError("버전을 알 수 없습니다. 파일 이름이 MyCivil3DMcp-<버전>-win-x64.zip 이어야 합니다.");
  const signed = checkSignature(zip, options.signature, options.allowUnsigned === true);
  const sha256 = await sha256File(zip);
  if (options.expectedSha256 && options.expectedSha256.toLowerCase() !== sha256)
    throw new ReleaseError("받은 파일의 SHA-256이 .sha256 파일과 다릅니다. 손상되었거나 바뀐 파일입니다.");
  const target = folder(version);
  const file = `MyCivil3DMcp-${version}-win-x64.zip`;
  const staging = target + ".tmp";
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  await copyFile(zip, join(staging, file));
  const release: Release = { version, file, sha256, size: statSync(zip).size, source: options.source, signed,
    ...(options.tag ? { tag: options.tag } : {}), addedAt: new Date().toISOString() };
  writeJson(join(staging, "release.json"), release);
  // 같은 버전을 다시 받으면 바꾼다(지정된 버전이면 다음 요청부터 새 파일).
  rmSync(target, { recursive: true, force: true });
  renameSync(staging, target);
  return release;
}

// GitHub Release에서 zip과 .sha256을 받아 보관한다. 비공개 저장소는 읽기 권한 토큰이 필요하다.
export async function fetchFromGitHub(repo: string, token: string | undefined, tag?: string): Promise<Release> {
  const api = `https://api.github.com/repos/${repo}/releases/${tag ? `tags/${encodeURIComponent(tag)}` : "latest"}`;
  const headers: Record<string, string> = { "Accept": "application/vnd.github+json", "User-Agent": "my-civil3d-mcp-central",
    ...(token ? { "Authorization": `Bearer ${token}` } : {}) };
  const response = await fetch(api, { headers });
  if (response.status === 404) throw new ReleaseError(`GitHub에서 릴리스를 찾지 못했습니다(${tag ?? "latest"}). 비공개 저장소면 githubToken이 필요합니다.`);
  if (!response.ok) throw new ReleaseError(`GitHub 응답 ${response.status}: ${(await response.text()).slice(0, 200)}`);
  const release = await response.json() as { tag_name: string; assets: { id: number; name: string }[] };
  const zip = release.assets.find(asset => zipVersion(asset.name));
  const hash = zip && release.assets.find(asset => asset.name === zip.name + ".sha256");
  const sig = zip && release.assets.find(asset => asset.name === zip.name + ".sig");
  if (!zip || !hash || !sig) throw new ReleaseError(`${release.tag_name}에 설치 zip, .sha256, .sig가 모두 있어야 합니다(서명된 릴리스만 받는다).`);

  const download = async (id: number) => {
    const asset = await fetch(`https://api.github.com/repos/${repo}/releases/assets/${id}`,
      { headers: { ...headers, "Accept": "application/octet-stream" } });
    if (!asset.ok) throw new ReleaseError(`파일을 받지 못했습니다(${asset.status}).`);
    return Buffer.from(await asset.arrayBuffer());
  };
  const expected = /^[a-f\d]{64}/i.exec((await download(hash.id)).toString("utf8").trim())?.[0];
  if (!expected) throw new ReleaseError(".sha256 파일 형식이 맞지 않습니다.");
  mkdirSync(root(), { recursive: true });
  const temporary = join(root(), `.download-${Date.now()}.zip`);
  try {
    writeFileSync(temporary, await download(zip.id));
    const signature = (await download(sig.id)).toString("ascii");
    return await addRelease(temporary, { version: zipVersion(zip.name), expectedSha256: expected, signature, source: "github", tag: release.tag_name });
  } finally {
    rmSync(temporary, { force: true });
  }
}

export const releaseFile = (release: Release) => join(folder(release.version), release.file);

// 받아 둔 설치본을 지운다. 지금 배포 중인 버전이면 배포도 멈춘다(설치 프로그램은 "배포 중인 버전 없음"으로 본다).
export function removeRelease(version: string): { stoppedPublishing: boolean } {
  if (!VERSION.test(version) || !existsSync(folder(version))) throw new ReleaseError(`받아 둔 ${version} 설치본이 없습니다.`);
  const live = readJson<Current>(join(root(), "current.json"));
  const stoppedPublishing = live?.version === version;
  if (stoppedPublishing) rmSync(join(root(), "current.json"), { force: true });
  rmSync(folder(version), { recursive: true, force: true });
  return { stoppedPublishing };
}
