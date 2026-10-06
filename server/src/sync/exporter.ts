import { randomBytes } from "node:crypto";
import { open, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { install } from "../data/install.js";
import { privateTerms } from "../data/terms.js";
import { writeAtomic } from "../files.js";
import { LOG_FILES, logsDir } from "../logs/workLog.js";
import { dataDir } from "../paths.js";
import { hour, leak } from "./privacy.js";
import { outRecord, type OutRecord } from "./records.js";
import type { SyncState } from "./syncState.js";

// Turns new local log lines into de-identified packages in data/outbox/pending, whether or
// not a central server is connected, so nothing is lost while it is not. A package that
// fails the last check goes to data/outbox/blocked with the reason and is never sent.
export const CLIENT = "my-civil3d-mcp/0.2";
const MAX_RECORDS = 500;
const MAX_READ = 4 * 1024 * 1024;

export type Package = { schema: 1; packageId: string; installId: string; client: string; createdAt: string; records: OutRecord[] };

export const outboxDir = (kind: "pending" | "blocked") => join(dataDir(), "outbox", kind);

// The complete lines added to a file since the cursor, and the new cursor.
async function newLines(path: string, from: number): Promise<{ lines: string[]; to: number }> {
  const size = (await stat(path)).size;
  if (size <= from) return { lines: [], to: size < from ? 0 : from };
  const handle = await open(path, "r");
  try {
    const length = Math.min(size - from, MAX_READ);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, from);
    const end = buffer.lastIndexOf(0x0a);
    if (end < 0) return { lines: [], to: from };
    return { lines: buffer.subarray(0, end).toString("utf8").split("\n"), to: from + end + 1 };
  } finally {
    await handle.close();
  }
}

export async function exportLogs(state: SyncState): Promise<{ packages: number; blocked: number; records: number }> {
  const records: OutRecord[] = [];
  const days = (await readdir(logsDir()).catch(() => [] as string[])).filter(day => /^\d{4}-\d{2}-\d{2}$/.test(day)).sort();
  const seen = new Set<string>();
  for (const day of days)
    for (const file of LOG_FILES) {
      const key = `${day}/${file}`;
      const path = join(logsDir(), day, file);
      const found = await newLines(path, state.cursors[key] ?? 0).catch(() => undefined);
      if (!found) continue;
      seen.add(key);
      for (const line of found.lines) {
        try {
          const record = outRecord(file, JSON.parse(line) as Record<string, unknown>);
          if (record) records.push(record);
        } catch { /* A broken line is skipped. */ }
      }
      state.cursors[key] = found.to;
    }
  // Cursors of log folders already removed by retention are dropped.
  for (const key of Object.keys(state.cursors)) if (!seen.has(key)) delete state.cursors[key];

  const { installId } = await install();
  const terms = await privateTerms();
  let packages = 0, blocked = 0;
  for (let index = 0; index < records.length; index += MAX_RECORDS) {
    const packageId = `${installId}-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
    const item: Package = { schema: 1, packageId, installId, client: CLIENT, createdAt: hour(new Date().toISOString()),
      records: records.slice(index, index + MAX_RECORDS) };
    const text = JSON.stringify(item);
    const reason = leak(text, terms);
    if (reason) {
      await writeAtomic(join(outboxDir("blocked"), `${packageId}.json`), JSON.stringify({ reason, blockedAt: new Date().toISOString(), package: item }, null, 1));
      blocked++;
    } else {
      await writeAtomic(join(outboxDir("pending"), `${packageId}.json`), text);
      packages++;
    }
  }
  state.lastExport = new Date().toISOString();
  return { packages, blocked, records: records.length };
}
