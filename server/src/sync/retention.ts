// 이 PC 데이터의 보관 기한 (docs/데이터관리_설계.md §7).
// 답변 재사용(memory/memoryStore.ts)과 수정안(changes/changeStore.ts)은 각자 기한이 지나면 지운다.

import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { pruneCandidates } from "../knowledge/candidateStore.js";
import { localDate, logsDir } from "../logs/workLog.js";
import { closeStaleTracking } from "../tracking/tracker.js";
import { outboxDir } from "./exporter.js";

const DAY = 24 * 60 * 60 * 1000;

export const RETENTION = {
  logsDays: 30,         // 작업 기록(원문 포함)
  pendingDays: 60,      // 보내지 못한 묶음
  blockedDays: 30,      // 검사에 막힌 묶음
  candidatesDays: 180   // 결정된 지식 후보
} as const;

// 폴더 안에서 기한이 지난 파일·폴더를 지운다. 지운 개수를 돌려준다.
async function removeOlder(folder: string, maxAgeMs: number): Promise<number> {
  let removed = 0;
  const now = Date.now();
  for (const name of await readdir(folder).catch(() => [] as string[])) {
    const path = join(folder, name);
    const info = await stat(path).catch(() => undefined);
    if (info && now - info.mtimeMs > maxAgeMs) {
      await rm(path, { recursive: true, force: true });
      removed++;
    }
  }
  return removed;
}

// 정리 한 번. 무엇을 몇 개 지웠는지 돌려준다.
export async function cleanUp(): Promise<Record<string, number>> {
  // 로그는 날짜 폴더 이름으로 판단한다.
  const oldest = localDate(new Date(Date.now() - RETENTION.logsDays * DAY));
  let logs = 0;
  for (const day of await readdir(logsDir()).catch(() => [] as string[])) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(day) && day < oldest) {
      await rm(join(logsDir(), day), { recursive: true, force: true });
      logs++;
    }
  }

  return {
    logs,
    pending: await removeOlder(outboxDir("pending"), RETENTION.pendingDays * DAY),
    blocked: await removeOlder(outboxDir("blocked"), RETENTION.blockedDays * DAY),
    candidates: await pruneCandidates(RETENTION.candidatesDays * DAY),
    tracking: await closeStaleTracking()
  };
}
