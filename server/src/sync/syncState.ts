import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeAtomic } from "../files.js";
import { dataDir } from "../paths.js";

// How far each local log has been turned into outgoing packages (bytes read), and the
// last results of each sync step, for /중앙.
export type SyncState = {
  schema: 1;
  cursors: Record<string, number>;
  lastExport?: string; lastPush?: string; lastPull?: string; lastError?: string;
  officialVersion?: number; sentPackages?: number; sentCandidates?: number;
};

const file = () => join(dataDir(), "sync-state.json");

export async function loadState(): Promise<SyncState> {
  try {
    const parsed = JSON.parse(await readFile(file(), "utf8")) as Partial<SyncState>;
    if (parsed.schema === 1 && parsed.cursors) return parsed as SyncState;
  } catch { /* First run. */ }
  return { schema: 1, cursors: {} };
}

export const saveState = (state: SyncState) => writeAtomic(file(), JSON.stringify(state, null, 1));
