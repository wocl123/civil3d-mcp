// 동기화 상태 (data/sync-state.json).
//   cursors: 로그 파일마다 어디까지(바이트) 보낼 묶음으로 만들었는지
//   last*:   마지막으로 묶음을 만든 / 보낸 / 받은 시각, 마지막 문제 (/중앙 표시용)

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeAtomic } from "../files.js";
import { dataDir } from "../paths.js";

export type SyncState = {
  schema: 1;
  cursors: Record<string, number>;   // "2026-10-06/turns.jsonl" → 읽은 바이트
  lastExport?: string;
  lastPush?: string;
  lastPull?: string;
  lastError?: string;
  officialVersion?: number;          // 받은 중앙 지식 버전
  sentPackages?: number;
  sentCandidates?: number;
};

const file = () => join(dataDir(), "sync-state.json");

export async function loadState(): Promise<SyncState> {
  try {
    const parsed = JSON.parse(await readFile(file(), "utf8")) as Partial<SyncState>;
    if (parsed.schema === 1 && parsed.cursors) return parsed as SyncState;
  } catch {
    // 처음 실행.
  }
  return { schema: 1, cursors: {} };
}

export const saveState = (state: SyncState) => writeAtomic(file(), JSON.stringify(state, null, 1));
