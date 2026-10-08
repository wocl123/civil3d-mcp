// 로컬 서비스의 뒤쪽 작업 (docs/데이터관리_설계.md §8). 한 번에 하나만 돌고, 답변을 붙잡지 않는다.
//   1) 열린 도면에서 추적 중인 값 다시 읽기 (사람이 고쳤는지)
//   2) 새 로그 → 보낼 묶음
//   3) 구글 드라이브: 사용자 PC는 보내기 폴더로 묶음·후보를 옮기고 승인 지식을 받는다(drive/memberSync.ts).
//      관리자 PC는 사용자 폴더들에서 가져오고 승인 지식·배포본을 넣어 준다(admin/adminSync.ts).
//
// 도는 때: 서비스 시작 5초 뒤, 10분마다, 질문이 끝나고 10초 뒤. 정리(보관 기한)는 시작할 때와 6시간마다.
// 1분마다(가벼운 확인): 관리자 PC면 새 사용자 폴더 수(팔레트 아래 줄에 표시).

import { readdir } from "node:fs/promises";
import { driveSettings } from "../data/settings.js";
import { adminSync, newMemberCount } from "../admin/adminSync.js";
import { memberSync } from "../drive/memberSync.js";
import { checkTracked } from "../tracking/tracker.js";
import { currentDrawingScope } from "../memory/drawingScope.js";
import { exportLogs, outboxDir } from "./exporter.js";
import { cleanUp } from "./retention.js";
import { loadState, saveState } from "./syncState.js";

const START_DELAY_MS = 5000;
const INTERVAL_MS = 10 * 60 * 1000;
const AFTER_TURN_MS = 10000;
const CLEANUP_MS = 6 * 60 * 60 * 1000;
const WATCH_MS = 60 * 1000;

export type SyncResult = {
  tracked: number;     // 기록한 수정 추적 결과 수
  exported: number;    // 새로 만든 묶음 수
  blocked: number;     // 검사에 막힌 묶음 수
  sent: number;        // 드라이브로 보낸(관리자 PC: 가져온) 묶음 수
  candidates: number;  // 보낸(가져온) 후보 수
  official?: number;   // 승인 지식 버전
  members?: number;    // 관리자 PC: 가져온 사용자 폴더 수
  linkFailures?: number; // 관리자 PC: 공유 링크로 받지 못해 zip을 따로 넣어 준 사용자 수
  problems?: string[]; // 관리자 PC: 받지 않은 파일 등
  error?: string;
};

let running: Promise<SyncResult> | undefined;
let soon: NodeJS.Timeout | undefined;

// 동기화 한 번. 이미 돌고 있으면 그 결과를 같이 기다린다.
export function runSync(): Promise<SyncResult> {
  running ??= syncOnce().finally(() => { running = undefined; });
  return running;
}

// 답변이 끝나면 조금 뒤에 한 번. 그사이에 답변이 여러 번 와도 한 번만 돈다.
export function syncSoon(): void {
  if (soon) clearTimeout(soon);
  soon = setTimeout(() => { soon = undefined; void runSync().catch(error => process.stderr.write(`MyCivil3DMcp sync failed: ${String(error)}\n`)); }, AFTER_TURN_MS);
  soon.unref();
}

// 서비스가 켜질 때 부른다.
export function startSyncLoop(): void {
  const run = () => void runSync().catch(error => process.stderr.write(`MyCivil3DMcp sync failed: ${String(error)}\n`));
  const clean = () => void cleanUp().catch(error => process.stderr.write(`MyCivil3DMcp clean-up failed: ${String(error)}\n`));
  setTimeout(() => { clean(); run(); void watch(); }, START_DELAY_MS).unref();
  setInterval(run, INTERVAL_MS).unref();
  setInterval(clean, CLEANUP_MS).unref();
  setInterval(() => void watch().catch(() => undefined), WATCH_MS).unref();
}

// 관리자 PC: 아직 보지 않은 새 사용자 폴더 수(/api/version → 팔레트 아래 줄). 관리자가 아니면 0.
let newMembers = 0;
export const newMemberFolders = () => newMembers;
export async function watch(): Promise<void> {
  const drive = await driveSettings();
  if (!drive?.admin || !drive.enabled) { newMembers = 0; return; }
  try {
    newMembers = await newMemberCount(drive);
  } catch {
    // 다음 확인 때 다시
  }
}

async function syncOnce(): Promise<SyncResult> {
  const result: SyncResult = { tracked: 0, exported: 0, blocked: 0, sent: 0, candidates: 0 };

  // 1) 수정 추적
  try {
    result.tracked = await checkTracked(await currentDrawingScope());
  } catch (error) {
    process.stderr.write(`MyCivil3DMcp tracking check failed: ${String(error)}\n`);
  }

  // 2) 로그 → 보낼 묶음 (드라이브 연결과 상관없이)
  const state = await loadState();
  const exported = await exportLogs(state);
  result.exported = exported.packages;
  result.blocked = exported.blocked;
  await saveState(state);

  // 3) 구글 드라이브
  const drive = await driveSettings();
  if (!drive?.enabled) return result;
  try {
    if (drive.admin) {
      const done = await adminSync(drive, state);
      Object.assign(result, { sent: done.sent, candidates: done.candidates, official: done.official, members: done.members, linkFailures: done.linkFailures, problems: done.problems });
    } else {
      Object.assign(result, await memberSync(drive, state));
    }
    delete state.lastError;
  } catch (error) {
    state.lastError = error instanceof Error ? error.message : String(error);
    result.error = state.lastError;
  }

  state.sentPackages = (state.sentPackages ?? 0) + result.sent;
  state.sentCandidates = (state.sentCandidates ?? 0) + result.candidates;
  await saveState(state);
  return result;
}

// /중앙 표시용: 동기화 상태, 대기 묶음 수, 막힌 묶음 수.
export async function syncStatus() {
  const [state, pending, blocked] = await Promise.all([
    loadState(),
    readdir(outboxDir("pending")).catch(() => [] as string[]),
    readdir(outboxDir("blocked")).catch(() => [] as string[])
  ]);
  return { state, pending: pending.length, blocked: blocked.length };
}
