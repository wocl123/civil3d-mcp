import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { privateTerms } from "../data/terms.js";
import { loadSettings, type CentralSettings } from "../data/settings.js";
import { writeAtomic } from "../files.js";
import { applyOfficial } from "../knowledge/centralKnowledge.js";
import { markSubmitted, unsentCandidates } from "../knowledge/candidateStore.js";
import { currentDrawingScope } from "../memory/drawingScope.js";
import { checkTracked } from "../tracking/tracker.js";
import { CentralError, getOfficial, sendCandidates, sendPackage } from "./centralClient.js";
import { exportLogs, outboxDir } from "./exporter.js";
import { blank, leak } from "./privacy.js";
import { cleanUp } from "./retention.js";
import { loadState, saveState, type SyncState } from "./syncState.js";

// The local service's background work (docs/데이터관리_설계.md §8): look at tracked values
// in the open drawing, turn new logs into outgoing packages, and when a central server is
// connected send packages and candidates and fetch the approved central knowledge.
// One run at a time; nothing here ever blocks a palette answer.
const START_DELAY_MS = 5000;
const INTERVAL_MS = 10 * 60 * 1000;
const AFTER_TURN_MS = 10000;
const CLEANUP_MS = 6 * 60 * 60 * 1000;

export type SyncResult = { tracked: number; exported: number; blocked: number; sent: number; candidates: number; official?: number; error?: string };

let running: Promise<SyncResult> | undefined;
let soon: NodeJS.Timeout | undefined;

export function runSync(): Promise<SyncResult> {
  running ??= syncOnce().finally(() => { running = undefined; });
  return running;
}

// After a palette answer: one run a little later, however many answers come in between.
export function syncSoon(): void {
  if (soon) clearTimeout(soon);
  soon = setTimeout(() => { soon = undefined; void runSync(); }, AFTER_TURN_MS);
  soon.unref();
}

export function startSyncLoop(): void {
  const run = () => void runSync().catch(error => process.stderr.write(`MyCivil3DMcp sync failed: ${String(error)}\n`));
  const clean = () => void cleanUp().catch(error => process.stderr.write(`MyCivil3DMcp clean-up failed: ${String(error)}\n`));
  setTimeout(() => { clean(); run(); }, START_DELAY_MS).unref();
  setInterval(run, INTERVAL_MS).unref();
  setInterval(clean, CLEANUP_MS).unref();
}

async function syncOnce(): Promise<SyncResult> {
  const result: SyncResult = { tracked: 0, exported: 0, blocked: 0, sent: 0, candidates: 0 };
  try { result.tracked = await checkTracked(await currentDrawingScope()); }
  catch (error) { process.stderr.write(`MyCivil3DMcp tracking check failed: ${String(error)}\n`); }

  const state = await loadState();
  const exported = await exportLogs(state);
  result.exported = exported.packages;
  result.blocked = exported.blocked;
  await saveState(state);

  const central = (await loadSettings()).central;
  if (!central?.enabled) return result;
  try {
    result.sent = await sendPending(central, state);
    result.candidates = await sendNewCandidates(central);
    const official = await getOfficial(central, state.officialVersion ?? 0);
    if (!official.unchanged) await applyOfficial(official);
    result.official = official.version;
    state.officialVersion = official.version;
    state.lastPull = new Date().toISOString();
    delete state.lastError;
  } catch (error) {
    state.lastError = error instanceof CentralError && error.status === 401
      ? "중앙 서버가 이 PC의 토큰을 받지 않습니다. /중앙 연결로 다시 연결해 주세요." : (error instanceof Error ? error.message : String(error));
    result.error = state.lastError;
  }
  state.sentPackages = (state.sentPackages ?? 0) + result.sent;
  state.sentCandidates = (state.sentCandidates ?? 0) + result.candidates;
  await saveState(state);
  return result;
}

// Sends waiting packages oldest first. The server takes each package id once, so a package
// sent again after a lost reply does no harm. One the server refuses as unsafe is kept as
// blocked; a connection problem stops the run and everything waits for the next one.
async function sendPending(central: CentralSettings, state: SyncState): Promise<number> {
  let sent = 0;
  const names = (await readdir(outboxDir("pending")).catch(() => [] as string[])).filter(name => name.endsWith(".json")).sort();
  for (const name of names) {
    const path = join(outboxDir("pending"), name);
    const text = await readFile(path, "utf8");
    try {
      await sendPackage(central, JSON.parse(text));
    } catch (error) {
      if (!(error instanceof CentralError) || error.status !== 422) throw error;
      await writeAtomic(join(outboxDir("blocked"), name), JSON.stringify({ reason: `서버 검사: ${error.message}`, blockedAt: new Date().toISOString(), package: JSON.parse(text) }, null, 1));
    }
    await rm(path, { force: true });
    sent++;
  }
  state.lastPush = new Date().toISOString();
  return sent;
}

// Candidates go without the user's words (evidence) and with private words blanked; one
// that still fails the check stays here.
async function sendNewCandidates(central: CentralSettings): Promise<number> {
  const unsent = await unsentCandidates();
  if (!unsent.length) return 0;
  const terms = await privateTerms();
  const ready = unsent.map(item => ({
    id: item.id,
    body: { localId: item.id, title: blank(item.title, terms), content: blank(item.content, terms),
      ...(item.parameter ? { parameter: item.parameter } : {}), provider: item.provider, at: item.at.slice(0, 10), localStatus: item.status }
  })).filter(item => !leak(JSON.stringify(item.body), terms));
  if (!ready.length) return 0;
  await sendCandidates(central, ready.map(item => item.body));
  await markSubmitted(ready.map(item => item.id));
  return ready.length;
}

// For /중앙: what is waiting, blocked, and when things last happened.
export async function syncStatus() {
  const [state, pending, blocked] = await Promise.all([loadState(),
    readdir(outboxDir("pending")).catch(() => [] as string[]), readdir(outboxDir("blocked")).catch(() => [] as string[])]);
  return { state, pending: pending.length, blocked: blocked.length };
}
