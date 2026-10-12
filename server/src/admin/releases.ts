// 배포본 보관과 배포 버전 지정 (관리자 PC, docs/배포_설치.md).
//   data/admin/releases/<버전>/<zip>          받아 둔 설치본
//   data/admin/releases/<버전>/release.json   버전, 파일, SHA-256, 크기, 태그
//   data/admin/releases/current.json          지금 배포하는 버전 + 최소 지원 버전
// 받아 두기만 해서는 배포되지 않는다. 지정(publish)하면 동기화 때 사용자들의 드라이브 폴더로 복사된다(adminSync.ts).
// GitHub Release에서 받을 때는 zip 전체 서명(.sig)을 공개 키로 확인한다. 설치 프로그램은 번들 안의 서명을 따로 확인한다.

import { createHash, verify } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { copyFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { adminDir } from "./adminConfig.js";
import { RELEASE_PUBLIC_KEY } from "./releaseKey.js";

export type Release = {
  version: string;
  file: string;          // releases/<버전>/ 안의 zip 이름
  sha256: string;
  size: number;
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
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) {
      return left[i] - right[i];
    }
  }

  return 0;
}

const root = () => join(adminDir(), "releases");
const folder = (version: string) => join(root(), version);

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}

function writeJson(file: string, value: unknown): void {
  writeFileSync(file + ".tmp", JSON.stringify(value, null, 1), "utf8");
  renameSync(file + ".tmp", file);
}

export const zipVersion = (name: string) => ZIP_NAME.exec(basename(name))?.[1];

export function readRelease(version: string): Release | undefined {
  if (!VERSION.test(version)) {
    return undefined;
  }

  const release = readJson<Release>(join(folder(version), "release.json"));
  return release && existsSync(join(folder(version), release.file)) ? release : undefined;
}

export function listReleases(): Release[] {
  if (!existsSync(root())) {
    return [];
  }

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
  if (!readRelease(version)) {
    throw new ReleaseError(`받아 둔 ${version} 설치본이 없습니다.`);
  }

  if (minVersion && (!VERSION.test(minVersion) || compareVersions(minVersion, version) > 0)) {
    throw new ReleaseError("최소 지원 버전은 배포 버전보다 높을 수 없습니다.");
  }

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

// 서명 확인용 공개 키. MY_CIVIL3D_RELEASE_PUBLIC_KEY_FILE은 테스트가 임시 키를 쓸 때만.
const publicKey = () => process.env.MY_CIVIL3D_RELEASE_PUBLIC_KEY_FILE
  ? readFileSync(process.env.MY_CIVIL3D_RELEASE_PUBLIC_KEY_FILE, "utf8") : RELEASE_PUBLIC_KEY;

// zip 하나를 확인하고 보관한다: 서명(.sig, base64)과 SHA-256(.sha256)이 맞아야 한다.
export async function addRelease(zip: string, signature: string, expectedSha256: string, tag?: string): Promise<Release> {
  const version = zipVersion(zip);
  if (!version) {
    throw new ReleaseError("버전을 알 수 없습니다. 파일 이름이 MyCivil3DMcp-<버전>-win-x64.zip 이어야 합니다.");
  }

  if (!verify("sha256", readFileSync(zip), publicKey(), Buffer.from(signature.trim(), "base64"))) {
    throw new ReleaseError("설치본의 서명이 맞지 않습니다(변조되었거나 공식 배포본이 아님). 받지 않습니다.");
  }

  const sha256 = await sha256File(zip);
  if (expectedSha256.toLowerCase() !== sha256) {
    throw new ReleaseError("받은 파일의 SHA-256이 .sha256 파일과 다릅니다. 손상되었거나 바뀐 파일입니다.");
  }

  const target = folder(version);
  const file = `MyCivil3DMcp-${version}-win-x64.zip`;
  const staging = target + ".tmp";
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  await copyFile(zip, join(staging, file));
  const release: Release = { version, file, sha256, size: statSync(zip).size, ...(tag ? { tag } : {}), addedAt: new Date().toISOString() };
  writeJson(join(staging, "release.json"), release);
  rmSync(target, { recursive: true, force: true });
  renameSync(staging, target);
  return release;
}

// Legacy ZIP support for migrating installs/tests; production publication uses scripts/drive-publish.mjs.
export async function fetchRelease(_unused: string, version: string): Promise<Release> {
  if (!VERSION.test(version)) {
    throw new ReleaseError("버전 형식이 맞지 않습니다.");
  }

  const source = process.env.MY_CIVIL3D_RELEASE_SOURCE;
  if (!source) {
    throw new ReleaseError("배포하기.bat에서 Google Drive로 배포하세요.");
  }

  const name = `MyCivil3DMcp-${version}-win-x64.zip`;
  const zip = join(source, name);
  const expected = /^[a-f\d]{64}/i.exec(readFileSync(zip + ".sha256", "utf8").trim())?.[0];
  if (!expected) {
    throw new ReleaseError(".sha256 파일 형식이 맞지 않습니다.");
  }

  return addRelease(zip, readFileSync(zip + ".sig", "ascii"), expected, "local");
}

export const releaseFile = (release: Release) => join(folder(release.version), release.file);

// 받아 둔 설치본을 지운다. 지금 배포 중인 버전이면 배포도 멈춘다.
export function removeRelease(version: string): { stoppedPublishing: boolean } {
  if (!VERSION.test(version) || !existsSync(folder(version))) {
    throw new ReleaseError(`받아 둔 ${version} 설치본이 없습니다.`);
  }

  const live = readJson<Current>(join(root(), "current.json"));
  const stoppedPublishing = live?.version === version;
  if (stoppedPublishing) {
    rmSync(join(root(), "current.json"), { force: true });
  }

  rmSync(folder(version), { recursive: true, force: true });
  return { stoppedPublishing };
}
