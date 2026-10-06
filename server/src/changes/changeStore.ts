import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { dataDir } from "../paths.js";
import type { CheckItem } from "../criteria/types/CheckItem.js";
import type { FixOption } from "../criteria/types/FixOption.js";
import type { StoredFix, FixSource } from "./types/StoredFix.js";
import type { ChangeLogEntry } from "./types/ChangeLogEntry.js";
import { supported } from "./describe.js";
import { logChangeEntry, recentLines } from "../logs/workLog.js";

// Fixes computed by the check tools are stored under data/changes/fixes with an id, so the
// AI can name one without restating its values, and the check that produced it can run
// again after the fix is applied. Every apply attempt is logged in data/logs/<date>/changes.jsonl.
// The MCP server (which checks and applies) and the palette service share these files.
const KEEP_MS = 2 * 24 * 60 * 60 * 1000;

const dir = (...parts: string[]) => join(dataDir(), "changes", ...parts);
const requestId = () => process.env.MY_CIVIL3D_REQUEST_ID ?? "none";

async function removeOld(folder: string): Promise<void> {
  const now = Date.now();
  for (const name of await readdir(folder).catch(() => [] as string[])) {
    const path = join(folder, name);
    if (now - (await stat(path)).mtimeMs > KEEP_MS) await rm(path, { force: true });
  }
}

// Gives every fix of the failed items an id and stores it with the check that produced it.
export async function registerFixes(items: CheckItem[], source: FixSource): Promise<void> {
  for (const item of items)
    for (const fix of item.fixes ?? []) await storeFix(fix, item.target, `${item.article} ${item.check}`, source);
}

// Stores one fix or creation plan and sets its id and whether the plug-in can apply it.
export async function storeFix(fix: FixOption, target: string, check: string, source: FixSource): Promise<void> {
  await removeOld(dir("fixes"));
  await mkdir(dir("fixes"), { recursive: true });
  // The request is part of the id: the same fix computed again in a later answer gets its own
  // id, so the ids offered in one answer are never taken over by another.
  fix.id = "fx-" + createHash("sha256").update(requestId() + JSON.stringify(fix.create ?? fix.changes)).digest("hex").slice(0, 10);
  fix.applicable = fix.status !== "conflict" &&
    (fix.create !== undefined || (fix.changes.length > 0 && fix.changes.every(supported)));
  const stored: StoredFix = { ...fix, id: fix.id, applicable: fix.applicable, target, check,
    createdAt: new Date().toISOString(), requestId: requestId(), source };
  await writeFile(dir("fixes", `${fix.id}.json`), JSON.stringify(stored, null, 1), "utf8");
}

export async function loadFix(id: string): Promise<StoredFix> {
  if (!/^fx-[a-f\d]{10}$/.test(id)) throw new Error(`Unknown fix id "${id}".`);
  const text = await readFile(dir("fixes", `${id}.json`), "utf8").catch(() => undefined);
  if (!text) throw new Error(`Fix ${id} was not found or has expired. Run the check again.`);
  return JSON.parse(text) as StoredFix;
}

// Fixes computed during one palette request. Their ids go into the conversation, and
// only those ids may be applied in the following questions.
export async function fixesFor(id: string): Promise<StoredFix[]> {
  const found: StoredFix[] = [];
  for (const name of await readdir(dir("fixes")).catch(() => [] as string[])) {
    const fix = JSON.parse(await readFile(dir("fixes", name), "utf8")) as StoredFix;
    if (fix.requestId === id) found.push(fix);
  }
  return found.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function logChange(entry: Omit<ChangeLogEntry, "at" | "requestId">): Promise<void> {
  await logChangeEntry({ requestId: requestId(), ...entry });
}

// Changes applied during one palette request, for the note under the answer.
export async function appliedFor(id: string): Promise<ChangeLogEntry[]> {
  return (await recentLines("changes.jsonl") as ChangeLogEntry[])
    .filter(entry => entry.requestId === id && entry.state === "applied");
}
