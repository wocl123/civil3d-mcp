// 관리자 PC의 드라이브 동기화 (drive/driveFolders.ts의 폴더 모양).
//   1) 이 PC의 기록·후보는 바로 보관함으로 가져온다.
//   2) 내 드라이브에서 사용자 보내기 폴더(공유받아 바로가기를 추가한 것)를 찾아
//      묶음·후보를 검사해 가져오고(admin/received.json에 적으면 사용자 PC가 지운다),
//      승인 지식과 배포 버전을 그 폴더의 admin/ 에 넣어 준다. 설치 파일은 공용 배포 폴더(링크 공유)에 한 부만 둔다.
//   3) 이 PC에도 승인 지식을 적용한다.
// 검사(validate.ts): 아는 항목만 남기고, 경로·파일 이름·메일이 남은 것은 받지 않는다.

import { createReadStream, createWriteStream } from "node:fs";
import { copyFile, mkdir, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { join } from "node:path";
import { install } from "../data/install.js";
import type { DriveSettings } from "../data/settings.js";
import { privateTerms } from "../data/terms.js";
import { writeAtomic } from "../files.js";
import { applyOfficial } from "../knowledge/centralKnowledge.js";
import { markSubmitted, unsentCandidates } from "../knowledge/candidateStore.js";
import { findDriveRoot, findMemberFolders, jsonFiles, LATEST_ZIP, RELEASE_FOLDER, STATUS_FILE, type MemberFolder } from "../drive/driveFolders.js";
import { DriveError, NO_DRIVE } from "../drive/memberSync.js";
import { outboxDir } from "../sync/exporter.js";
import { blank, leak } from "../sync/privacy.js";
import type { SyncState } from "../sync/syncState.js";
import { loadAdminConfig } from "./adminConfig.js";
import { adminStore, type AdminStore } from "./adminStore.js";
import { current, releaseFile } from "./releases.js";
import { groupKey } from "./review.js";
import { Invalid, validCandidates, validPackage, type CandidateIn } from "./validate.js";

// linkFailures: 링크로 설치 파일을 받지 못해 zip을 따로 넣어 준 사용자 수(링크가 바뀌었을 수 있다)
export type AdminResult = { sent: number; candidates: number; official: number; members: number; refused: number; linkFailures: number; problems: string[] };

const readJson = async <T>(file: string): Promise<T | undefined> => {
  try { return JSON.parse((await readFile(file, "utf8")).replace(/^﻿/, "")) as T; } catch { return undefined; }
};
const today = () => new Date().toISOString().slice(0, 10);

// 후보 하나를 보관함에 더한다(같은 설치·후보 id는 한 번만).
function addCandidate(store: AdminStore, installId: string, item: CandidateIn): boolean {
  if (store.candidates.some(row => row.installId === installId && row.localId === item.localId)) return false;
  store.candidates.push({ id: `S-${store.candidates.length + 1}`, installId, ...item, groupKey: groupKey(item.content), receivedAt: new Date().toISOString(), status: "pending" });
  return true;
}

export async function adminSync(drive: DriveSettings, state: SyncState): Promise<AdminResult> {
  const store = adminStore();
  const result: AdminResult = { sent: 0, candidates: 0, official: store.official.version, members: 0, refused: 0, linkFailures: 0, problems: [] };
  const own = (await install()).installId;

  // 1) 이 PC의 기록과 후보
  for (const name of await jsonFiles(outboxDir("pending"))) {
    const from = join(outboxDir("pending"), name);
    const text = await readFile(from, "utf8");
    try {
      const { packageId, records } = validPackage(JSON.parse(text), own);
      if (!store.packages.has(packageId)) store.addPackage(own, packageId, records);
      result.sent++;
    } catch (error) {
      if (!(error instanceof Invalid)) throw error;
      const report = { reason: `관리자 검사: ${error.message}`, blockedAt: new Date().toISOString(), package: JSON.parse(text) };
      await writeAtomic(join(outboxDir("blocked"), name), JSON.stringify(report, null, 1));
    }
    await rm(from, { force: true });
  }
  const terms = await privateTerms();
  const mine = (await unsentCandidates()).map(item => ({ id: item.id, body: { localId: item.id, title: blank(item.title, terms), content: blank(item.content, terms),
    ...(item.parameter ? { parameter: item.parameter } : {}), provider: item.provider, at: item.at.slice(0, 10), localStatus: item.status } }))
    .filter(item => !leak(JSON.stringify(item.body), terms));
  if (mine.length) {
    for (const item of validCandidates({ candidates: mine.map(entry => entry.body) })) if (addCandidate(store, own, item)) result.candidates++;
    store.saveCandidates();
    await markSubmitted(mine.map(item => item.id));
  }
  state.lastPush = new Date().toISOString();

  // 2) 사용자 폴더
  const root = findDriveRoot(drive.root);
  if (!root) throw new DriveError(NO_DRIVE);
  const live = current();
  const { downloadId } = loadAdminConfig();
  if (live) {
    try {
      await updateSharedRelease(root, live);
    } catch (error) {
      result.problems.push(`공용 배포 폴더: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  for (const folder of await findMemberFolders(root)) {
    if (folder.installId === own) continue;
    const known = store.members[folder.installId];
    // 같은 설치 ID를 다른 폴더가 주장하면(복사·위조) 가져오지 않는다.
    if (known && known.folder !== folder.name) { result.problems.push(`${folder.name}: 이미 다른 폴더(${known.folder})가 쓰는 설치 ID라 건너뜀`); continue; }
    const member = store.members[folder.installId] ??= { installId: folder.installId, folder: folder.name, firstSeen: today(), lastSeen: today(), seen: false };
    member.lastSeen = today();
    if (member.blocked) continue;
    result.members++;
    try {
      const taken = await importFolder(store, folder, result);
      await shareBack(folder, store, live, downloadId, taken, result);
    } catch (error) {
      result.problems.push(`${folder.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  store.saveMembers();
  store.saveCandidates();

  // 3) 이 PC의 승인 지식
  if (store.official.version !== (state.officialVersion ?? 0)) {
    await applyOfficial(store.official);
    state.officialVersion = store.official.version;
  }
  state.lastPull = new Date().toISOString();
  return result;
}

// 한 사용자 폴더의 묶음·후보를 가져온다. 가져갔거나(이미 있는 것 포함) 받지 않기로 한 파일 id를 돌려준다.
async function importFolder(store: AdminStore, folder: MemberFolder, result: AdminResult): Promise<{ packages: string[]; candidates: string[] }> {
  const taken = { packages: [] as string[], candidates: [] as string[] };
  for (const name of await jsonFiles(join(folder.path, "packages"))) {
    const id = name.slice(0, -5);
    if (store.packages.has(id)) { taken.packages.push(id); continue; }
    const body = await readJson(join(folder.path, "packages", name));
    if (body === undefined) continue;   // 아직 동기화 중일 수 있다: 다음 번에
    try {
      const { packageId, records } = validPackage(body, folder.installId);
      if (packageId !== id) throw new Invalid("파일 이름과 묶음 id가 다릅니다.");
      store.addPackage(folder.installId, packageId, records);
      result.sent++;
    } catch (error) {
      if (!(error instanceof Invalid)) throw error;
      result.refused++;
      result.problems.push(`${folder.name}/${name}: ${error.message}`);
    }
    taken.packages.push(id);
  }
  for (const name of await jsonFiles(join(folder.path, "candidates"))) {
    const id = name.slice(0, -5);
    const body = await readJson(join(folder.path, "candidates", name));
    if (body === undefined) continue;
    try {
      for (const item of validCandidates({ candidates: [body] })) if (addCandidate(store, folder.installId, item)) result.candidates++;
    } catch (error) {
      if (!(error instanceof Invalid)) throw error;
      result.refused++;
    }
    taken.candidates.push(id);
  }
  return taken;
}

// 공용 배포 폴더(링크 공유)의 파일을 배포 버전으로 맞춘다. 같은 파일에 덮어써서 파일 ID(링크)가 바뀌지 않게 한다.
async function updateSharedRelease(root: string, live: NonNullable<ReturnType<typeof current>>): Promise<void> {
  const dir = join(root, RELEASE_FOLDER);
  await mkdir(dir, { recursive: true });
  const info = await readJson<{ version?: string; sha256?: string }>(join(dir, "release.json"));
  const zip = join(dir, LATEST_ZIP);
  if (info?.version === live.release.version && info.sha256 === live.release.sha256 && (await stat(zip).catch(() => undefined))?.size === live.release.size) return;
  await pipeline(createReadStream(releaseFile(live.release)), createWriteStream(zip, { flags: "w" }));
  await writeAtomic(join(dir, "release.json"), JSON.stringify({ version: live.release.version, sha256: live.release.sha256, size: live.release.size }, null, 1));
}

// 링크로 받지 못했다고 알린 사용자(status.json의 linkFailed가 지금 배포 버전)인지.
async function linkFailed(folder: MemberFolder, version: string): Promise<boolean> {
  return (await readJson<{ linkFailed?: unknown }>(join(folder.path, STATUS_FILE)))?.linkFailed === version;
}

// 사용자 폴더의 admin/ 에 가져간 목록, 승인 지식, 배포 버전을 넣는다(바뀐 것만 쓴다).
// 배포 버전: 링크(downloadId)가 있으면 작은 release.json만 넣는다. 링크가 없거나 그 사용자가 링크로 받지 못했으면 zip을 따로 넣는다.
async function shareBack(folder: MemberFolder, store: AdminStore, live: ReturnType<typeof current>, downloadId: string | undefined,
  taken: { packages: string[]; candidates: string[] }, result: AdminResult): Promise<void> {
  const dir = join(folder.path, "admin");
  const write = async (name: string, value: unknown) => {
    const text = JSON.stringify(value, null, 1);
    if ((await readFile(join(dir, name), "utf8").catch(() => undefined)) !== text) await writeAtomic(join(dir, name), text);
  };
  await write("received.json", taken);
  if (store.official.version > 0) await write("official.json", store.official);

  let keepZip: string | undefined;
  if (!live) {
    await rm(join(dir, "release.json"), { force: true });
  } else {
    const copy = !downloadId || await linkFailed(folder, live.release.version);
    if (copy) {
      // zip을 먼저 다 쓴 뒤 release.json을 바꾼다(사용자 PC가 반쯤 쓴 파일을 받지 않게).
      keepZip = live.release.file;
      const target = join(dir, live.release.file);
      if ((await stat(target).catch(() => undefined))?.size !== live.release.size) {
        await copyFile(releaseFile(live.release), target + ".part");
        await rename(target + ".part", target);
      }
      if (downloadId) result.linkFailures++;
    }
    const { version, sha256, size, file } = live.release;
    await write("release.json", { version, sha256, size, file, publishedAt: live.publishedAt, ...(live.minVersion ? { minVersion: live.minVersion } : {}),
      ...(downloadId && !copy ? { downloadId } : {}) });
  }
  for (const name of await readdir(dir).catch(() => [] as string[]))
    if (/^MyCivil3DMcp-.*\.zip(\.part)?$/.test(name) && name !== keepZip) await rm(join(dir, name), { force: true });
}

// 팔레트 아래 줄: 아직 /중앙 사용자 로 보지 않은 새 사용자 폴더 수(차단한 것은 빼고).
export async function newMemberCount(drive: DriveSettings): Promise<number> {
  const root = findDriveRoot(drive.root);
  if (!root) return 0;
  const store = adminStore();
  const own = (await install()).installId;
  return (await findMemberFolders(root)).filter(folder => folder.installId !== own && !store.members[folder.installId]?.seen && !store.members[folder.installId]?.blocked).length;
}
