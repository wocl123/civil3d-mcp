// 사용자 PC의 드라이브 동기화 (driveFolders.ts의 폴더 모양).
//   1) 관리자가 가져간 묶음·후보(admin/received.json)는 보내기 폴더에서 지운다.
//   2) 보낼 묶음(data/outbox/pending)을 보내기 폴더로 옮긴다.
//   3) 아직 안 보낸 지식 후보를 비식별 처리해 넣는다(근거=사용자 말은 빼고, 가릴 낱말은 바꾼다).
//   4) 관리자가 넣어 준 승인 지식(admin/official.json)이 새 버전이면 적용한다.
// 관리자와 공유하기 전에도 폴더에 쌓인다(내 드라이브 안이라 다른 사람은 못 본다). 60일 넘은 묶음은 지운다.

import { existsSync } from "node:fs";
import { readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { install } from "../data/install.js";
import type { DriveSettings } from "../data/settings.js";
import { privateTerms } from "../data/terms.js";
import { writeAtomic } from "../files.js";
import { applyOfficial, type Official } from "../knowledge/centralKnowledge.js";
import { markSubmitted, unsentCandidates } from "../knowledge/candidateStore.js";
import { outboxDir } from "../sync/exporter.js";
import { blank, leak } from "../sync/privacy.js";
import { RETENTION } from "../sync/retention.js";
import type { SyncState } from "../sync/syncState.js";
import { ensureMemberFolder, findDriveRoot, jsonFiles, memberFolderName } from "./driveFolders.js";

export class DriveError extends Error {}

export const NO_DRIVE = "구글 드라이브 폴더를 찾지 못했습니다. Google Drive for Desktop을 설치하고 로그인해 주세요(다른 위치면 /중앙 드라이브 <경로>).";

const readJson = async <T>(file: string): Promise<T | undefined> => {
  try { return JSON.parse((await readFile(file, "utf8")).replace(/^﻿/, "")) as T; } catch { return undefined; }
};

// 승인 지식 파일이 맞는 모양인지.
export function validOfficial(value: unknown): Official | undefined {
  const item = value as Partial<Official> | undefined;
  if (!item || typeof item.version !== "number" || !Array.isArray(item.items) || !item.parameters || typeof item.parameters !== "object") return undefined;
  const items = item.items.filter(entry => entry && typeof entry.id === "string" && typeof entry.content === "string")
    .map(entry => ({ id: entry.id, content: entry.content.slice(0, 400), approvedAt: String(entry.approvedAt ?? ""), ...(entry.parameter ? { parameter: entry.parameter } : {}) }));
  return { version: item.version, publishedAt: item.publishedAt, items, parameters: item.parameters };
}

export async function memberSync(drive: DriveSettings, state: SyncState): Promise<{ sent: number; candidates: number; official?: number }> {
  const root = findDriveRoot(drive.root);
  if (!root) throw new DriveError(NO_DRIVE);
  const folder = await ensureMemberFolder(root, (await install()).installId);

  // 1) 관리자가 가져간 것 지우기
  const received = await readJson<{ packages?: unknown; candidates?: unknown }>(join(folder, "admin", "received.json"));
  const names = (list: unknown) => Array.isArray(list) ? list.filter((id): id is string => typeof id === "string" && /^[\w.-]{1,80}$/.test(id)) : [];
  for (const id of names(received?.packages)) await rm(join(folder, "packages", `${id}.json`), { force: true });
  for (const id of names(received?.candidates)) await rm(join(folder, "candidates", `${id}.json`), { force: true });
  if (received) state.lastPull = new Date().toISOString();

  // 2) 묶음 옮기기(드라이브에 쓴 뒤 이 PC에서 지운다)
  let sent = 0;
  for (const name of await jsonFiles(outboxDir("pending"))) {
    const from = join(outboxDir("pending"), name);
    await writeAtomic(join(folder, "packages", name), await readFile(from, "utf8"));
    await rm(from, { force: true });
    sent++;
  }
  // 관리자가 끝내 가져가지 않은 묶음은 보관 기한이 지나면 지운다.
  const now = Date.now();
  for (const name of await jsonFiles(join(folder, "packages"))) {
    const info = await stat(join(folder, "packages", name)).catch(() => undefined);
    if (info && now - info.mtimeMs > RETENTION.pendingDays * 24 * 3600000) await rm(join(folder, "packages", name), { force: true });
  }

  // 3) 지식 후보
  const candidates = await sendCandidates(folder);

  // 4) 승인 지식
  const official = validOfficial(await readJson(join(folder, "admin", "official.json")));
  if (official && official.version !== (state.officialVersion ?? 0)) {
    await applyOfficial(official);
    state.officialVersion = official.version;
  }

  if (sent) state.lastPush = new Date().toISOString();
  return { sent, candidates, ...(official ? { official: official.version } : {}) };
}

// 아직 안 보낸 후보를 넣는다. 그래도 검사에 걸리는 후보는 넣지 않고 남겨 둔다.
async function sendCandidates(folder: string): Promise<number> {
  const unsent = await unsentCandidates();
  if (!unsent.length) return 0;
  const terms = await privateTerms();
  const ready = unsent.map(item => ({
    id: item.id,
    body: {
      localId: item.id,
      title: blank(item.title, terms),
      content: blank(item.content, terms),
      ...(item.parameter ? { parameter: item.parameter } : {}),
      provider: item.provider,
      at: item.at.slice(0, 10),
      localStatus: item.status
    }
  })).filter(item => !leak(JSON.stringify(item.body), terms));
  for (const item of ready) await writeAtomic(join(folder, "candidates", `${item.id}.json`), JSON.stringify(item.body));
  if (ready.length) await markSubmitted(ready.map(item => item.id));
  return ready.length;
}

// /중앙 표시용: 드라이브, 보내기 폴더, 관리자가 가져가기 시작했는지, 폴더에 남은 묶음 수.
export async function memberStatus(drive: DriveSettings) {
  const root = findDriveRoot(drive.root);
  const { installId } = await install();
  const folder = root ? join(root, memberFolderName(installId)) : undefined;
  const exists = !!folder && existsSync(folder);
  const received = exists ? await stat(join(folder!, "admin", "received.json")).catch(() => undefined) : undefined;
  return {
    root,
    folder: exists ? folder : undefined,
    name: memberFolderName(installId),
    connected: exists && existsSync(join(folder!, "admin")),
    lastTaken: received?.mtime.toISOString(),
    waiting: exists ? (await readdir(join(folder!, "packages")).catch(() => [] as string[])).filter(name => name.endsWith(".json")).length : 0
  };
}
