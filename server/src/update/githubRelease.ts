// Public release-only GitHub repository. No account/token is shipped to user PCs.
import { verify } from "node:crypto";
import { trustedReleaseKey } from "./driveRelease.js";
export const validGitHubRepo = (value: unknown): value is string =>
  typeof value === "string" && /^[a-z\d][a-z\d-]{0,38}\/[a-z\d_.-]{1,100}$/i.test(value)
  && ![".", ".."].includes(value.split("/")[1]);
export type GitHubRelease = {
  schema: 1; repo: string; version: string; file: string; size: number; sha256: string;
  signature: string; publishedAt: string; downloadUrl: string; minVersion?: string;
};
export function githubAssetUrl(repo: string, version: string, file: string): string {
  if (!validGitHubRepo(repo) || !/^\d+\.\d+\.\d+$/.test(version)
      || !["latest.json", `MyCivil3DMcp-${version}-win-x64.exe`].includes(file)) throw new Error("GitHub 배포 경로 형식 오류");
  return `https://github.com/${repo}/releases/download/v${version}/${file}`;
}
export function validGitHubRelease(value: unknown, repo: string): GitHubRelease {
  const r = value as Partial<GitHubRelease> | undefined;
  if (!validGitHubRepo(repo) || !r || r.schema !== 1 || r.repo !== repo
      || !/^\d+\.\d+\.\d+$/.test(r.version ?? "") || r.file !== `MyCivil3DMcp-${r.version}-win-x64.exe`
      || !Number.isSafeInteger(r.size) || r.size! <= 0 || r.size! > 1024 * 1024 * 1024
      || !/^[a-f\d]{64}$/.test(r.sha256 ?? "") || typeof r.signature !== "string"
      || !/^[A-Za-z0-9+/]+=*$/.test(r.signature) || !Number.isFinite(Date.parse(r.publishedAt ?? ""))
      || (r.minVersion !== undefined && !/^\d+\.\d+\.\d+$/.test(r.minVersion)))
    throw new Error("GitHub 배포 정보 형식 오류");
  if (r.downloadUrl !== githubAssetUrl(repo, r.version!, r.file!)) throw new Error("GitHub 설치파일 경로가 배포 정보와 다릅니다.");
  if (r.minVersion) {
    const a = r.minVersion.split(".").map(Number), b = r.version!.split(".").map(Number);
    for (let i = 0; i < 3; i++) if (a[i] !== b[i]) {
      if (a[i] > b[i]) throw new Error("최소 버전이 배포 버전보다 높습니다.");
      break;
    }
  }
  return r as GitHubRelease;
}
function allowedUrl(value: string): void {
  const u = new URL(value);
  if (u.protocol !== "https:" || u.port || u.username || u.password
      || !["api.github.com", "github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"].includes(u.hostname))
    throw new Error("허용되지 않은 GitHub 다운로드 주소입니다.");
}
async function fetchBytes(url: string, maxBytes: number, absent = false): Promise<Buffer | undefined> {
  let target = url;
  const testBase = process.env.MY_CIVIL3D_GITHUB_TEST_BASE;
  if (testBase && !/^http:\/\/127\.0\.0\.1:\d+$/.test(testBase)) throw new Error("GitHub 테스트 주소는 로컬 호스트만 허용됩니다.");
  for (let hop = 0; hop < 6; hop++) {
    allowedUrl(target);
    const u = new URL(target);
    const response = await fetch(testBase ? testBase + u.pathname + u.search : target, {
      redirect: "manual", headers: { "user-agent": "MyCivil3DMcp", accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(10 * 60 * 1000), cache: "no-store"
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const next = response.headers.get("location"); await response.body?.cancel();
      if (!next) throw new Error("GitHub 다운로드 이동 주소가 없습니다.");
      target = new URL(next, target).href; continue;
    }
    if (response.status === 404 && absent) { await response.body?.cancel(); return undefined; }
    if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error(`GitHub 다운로드 실패(HTTP ${response.status})`); }
    if (Number(response.headers.get("content-length")) > maxBytes) { await response.body.cancel(); throw new Error("GitHub 파일 크기 제한 초과"); }
    const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
    try {
      while (true) { const { done, value } = await reader.read(); if (done) break;
        size += value.byteLength; if (size > maxBytes) { await reader.cancel(); throw new Error("GitHub 파일 크기 제한 초과"); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    return Buffer.concat(chunks, size);
  }
  throw new Error("GitHub 다운로드 이동 횟수 초과");
}
export async function downloadGitHubAsset(url: string, maxBytes: number): Promise<Buffer> {
  if (!/^https:\/\/github\.com\/[^/]+\/[^/]+\/releases\/download\/v\d+\.\d+\.\d+\/MyCivil3DMcp-\d+\.\d+\.\d+-win-x64\.exe$/.test(url))
    throw new Error("GitHub 설치파일 주소 형식 오류");
  return (await fetchBytes(url, maxBytes))!;
}
export async function readGitHubRelease(repo: string): Promise<GitHubRelease | undefined> {
  if (!validGitHubRepo(repo)) throw new Error("GitHub 배포 저장소 형식 오류");
  const infoBytes = await fetchBytes(`https://api.github.com/repos/${repo}/releases/latest`, 256 * 1024, true);
  if (!infoBytes) return undefined;
  const info = JSON.parse(infoBytes.toString("utf8"));
  const version = typeof info.tag_name === "string" ? /^v(\d+\.\d+\.\d+)$/.exec(info.tag_name)?.[1] : undefined;
  if (!version || info.draft !== false || info.prerelease !== false || !Array.isArray(info.assets))
    throw new Error("GitHub 정식 릴리스 정보 형식 오류");
  const file = `MyCivil3DMcp-${version}-win-x64.exe`;
  for (const name of ["latest.json", file])
    if (info.assets.filter((a: { name?: string; state?: string }) => a.name === name && a.state === "uploaded").length !== 1)
      throw new Error("GitHub 릴리스에 검증된 설치파일/업데이트 정보가 없습니다.");
  const bytes = (await fetchBytes(githubAssetUrl(repo, version, "latest.json"), 64 * 1024))!;
  const envelope = JSON.parse(bytes.toString("utf8"));
  if (envelope.schema !== 1 || typeof envelope.payload !== "string" || typeof envelope.signature !== "string")
    throw new Error("서명된 GitHub 배포 정보가 아닙니다.");
  const payload = Buffer.from(envelope.payload, "base64");
  if (!verify("sha256", payload, await trustedReleaseKey(), Buffer.from(envelope.signature, "base64")))
    throw new Error("GitHub 배포 정보 서명이 맞지 않습니다.");
  const release = validGitHubRelease(JSON.parse(payload.toString("utf8")), repo);
  if (release.version !== version) throw new Error("GitHub 태그와 서명된 배포 버전이 다릅니다.");
  return release;
}
