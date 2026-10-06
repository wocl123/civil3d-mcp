import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { pruneCandidates } from "../knowledge/candidateStore.js";
import { localDate, logsDir } from "../logs/workLog.js";
import { closeStaleTracking } from "../tracking/tracker.js";
import { outboxDir } from "./exporter.js";

// How long each kind of local data is kept (docs/데이터관리_설계.md §7). The answer cache
// (memory/memoryStore.ts) and computed fixes (changes/changeStore.ts) expire on their own.
const DAY = 24 * 60 * 60 * 1000;
export const RETENTION = { logsDays: 30, pendingDays: 60, blockedDays: 30, candidatesDays: 180 } as const;

async function removeOlder(folder: string, maxAgeMs: number): Promise<number> {
  let removed = 0;
  const now = Date.now();
  for (const name of await readdir(folder).catch(() => [] as string[])) {
    const path = join(folder, name);
    const info = await stat(path).catch(() => undefined);
    if (info && now - info.mtimeMs > maxAgeMs) { await rm(path, { recursive: true, force: true }); removed++; }
  }
  return removed;
}

export async function cleanUp(): Promise<Record<string, number>> {
  const oldest = localDate(new Date(Date.now() - RETENTION.logsDays * DAY));
  let logs = 0;
  for (const day of await readdir(logsDir()).catch(() => [] as string[]))
    if (/^\d{4}-\d{2}-\d{2}$/.test(day) && day < oldest) { await rm(join(logsDir(), day), { recursive: true, force: true }); logs++; }
  return {
    logs,
    pending: await removeOlder(outboxDir("pending"), RETENTION.pendingDays * DAY),
    blocked: await removeOlder(outboxDir("blocked"), RETENTION.blockedDays * DAY),
    candidates: await pruneCandidates(RETENTION.candidatesDays * DAY),
    tracking: await closeStaleTracking()
  };
}
