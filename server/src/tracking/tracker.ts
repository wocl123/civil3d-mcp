import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { readSection } from "../civil/civilData.js";
import type { AlignmentElement } from "../civil/types/AlignmentElement.js";
import type { ProfileCurve } from "../civil/types/ProfileCurve.js";
import type { ProfilePvi } from "../civil/types/ProfilePvi.js";
import { failureGuide } from "../errors/failureGuide.js";
import { writeAtomic } from "../files.js";
import { logEvent } from "../logs/workLog.js";
import { hashKey } from "../memory/memoryStore.js";
import type { DrawingScope } from "../memory/types/DrawingScope.js";
import { dataDir } from "../paths.js";

// Whether people keep what the AI drew. Every value the AI set in the drawing (a created
// alignment's curves, an applied fix) is remembered in data/tracking/<drawing>.json and
// read again later. A value people changed is the clearest sign of what the AI should
// have done; one left alone for 14 days counts as kept. Results go to
// data/logs/<date>/events.jsonl as "modification" events, which are sent de-identified
// (sync/records.ts) and counted by the central server.
// What this cannot see: changes discarded by closing the drawing without saving.
const KEEP_DAYS = 14;
const TOLERANCE = 0.001;
const STOP = new Set(["old_plugin", "not_connected", "timeout", "disconnected", "no_drawing"]);

export type TrackedProperty = "radius" | "spiralLength" | "elevation" | "curveLength";
export type TrackConditions = { designSpeed?: number; roadClass?: string; region?: string; criteria?: string };

export type Tracked = {
  id: string; source: "create" | "fix"; check?: string;
  objectKind: "alignment" | "profile"; handle: string;
  // Alignments: the curve group number; profiles: the PVI station.
  curve?: number; at?: number;
  property: TrackedProperty; aiValue: number; lastValue: number;
  // For a created alignment, how many curve groups it had, to notice curves added or removed.
  groups?: number;
  conditions: TrackConditions; createdAt: string; modifiedAt?: string;
};
type TrackFile = { drawing: string; lastState?: string; items: Tracked[] };
type Outcome = "modified" | "kept" | "deleted" | "restructured";

const dir = () => join(dataDir(), "tracking");
const fileOf = (scope: DrawingScope) => join(dir(), `${hashKey(scope.key).slice(0, 16)}.json`);

async function load(scope: DrawingScope): Promise<TrackFile> {
  try { return JSON.parse(await readFile(fileOf(scope), "utf8")) as TrackFile; }
  catch { return { drawing: hashKey(scope.key).slice(0, 16), items: [] }; }
}

let writing: Promise<unknown> = Promise.resolve();
const queued = <T>(work: () => Promise<T>): Promise<T> => {
  const next = writing.then(work);
  writing = next.catch(() => undefined);
  return next;
};

// Remembers values the AI just set in the open drawing.
export async function track(scope: DrawingScope, items: Omit<Tracked, "id" | "lastValue" | "createdAt">[]): Promise<void> {
  if (!scope.key || !items.length) return;
  await queued(async () => {
    const file = await load(scope);
    const now = new Date().toISOString();
    for (const item of items) {
      // A later change to the same value replaces the earlier record: the AI's latest value is what counts.
      file.items = file.items.filter(old => !(old.handle === item.handle && old.property === item.property &&
        old.curve === item.curve && old.at === item.at));
      file.items.push({ ...item, id: hashKey(item.handle, item.property, String(item.curve ?? item.at), now).slice(0, 12), lastValue: item.aiValue, createdAt: now });
    }
    file.lastState = scope.state;
    await writeAtomic(fileOf(scope), JSON.stringify(file, null, 1));
  }).catch(error => process.stderr.write(`MyCivil3DMcp tracking was not saved: ${String(error)}\n`));
}

type Reading = { value?: number; outcome?: Exclude<Outcome, "modified" | "kept"> };

const missing = (error: unknown) => /was not found|not found\.$/i.test(error instanceof Error ? error.message : String(error));

async function readAlignment(handle: string, items: Tracked[]): Promise<Map<Tracked, Reading>> {
  const out = new Map<Tracked, Reading>();
  let elements: AlignmentElement[];
  try { elements = await readSection<AlignmentElement>("alignment.section", { alignment: handle }, "elements"); }
  catch (error) {
    if (!missing(error)) throw error;
    for (const item of items) out.set(item, { outcome: "deleted" });
    return out;
  }
  const groups = [...new Set(elements.filter(element => element.curveGroup > 0).map(element => element.curveGroup))];
  for (const item of items) {
    const group = elements.filter(element => element.curveGroup === item.curve);
    if ((item.groups !== undefined && groups.length !== item.groups) || !group.length) { out.set(item, { outcome: "restructured" }); continue; }
    const value = item.property === "radius" ? group.find(element => element.kind === "Arc")?.radius
      : group.find(element => element.kind === "Spiral")?.length ?? 0;
    out.set(item, value === undefined ? { outcome: "restructured" } : { value });
  }
  return out;
}

async function readProfile(handle: string, items: Tracked[]): Promise<Map<Tracked, Reading>> {
  const out = new Map<Tracked, Reading>();
  let pvis: ProfilePvi[], curves: ProfileCurve[];
  try {
    [pvis, curves] = await Promise.all([
      readSection<ProfilePvi>("profile.section", { profile: handle }, "pvis"),
      readSection<ProfileCurve>("profile.section", { profile: handle }, "curves")
    ]);
  } catch (error) {
    if (!missing(error)) throw error;
    for (const item of items) out.set(item, { outcome: "deleted" });
    return out;
  }
  for (const item of items) {
    const near = (station: number) => item.at !== undefined && Math.abs(station - item.at) < 0.01;
    const value = item.property === "elevation" ? pvis.find(pvi => near(pvi.station))?.elevation
      : curves.find(curve => near(curve.pviStation))?.length ?? 0;
    out.set(item, value === undefined ? { outcome: "restructured" } : { value });
  }
  return out;
}

function emit(item: Tracked, outcome: Outcome, userValue?: number): Promise<void> {
  return logEvent({
    type: "modification", outcome, source: item.source, check: item.check, objectKind: item.objectKind, property: item.property,
    aiValue: item.aiValue, ...(userValue !== undefined ? { userValue } : {}),
    ageHours: Math.round((Date.now() - Date.parse(item.createdAt)) / 3600000), conditions: item.conditions
  });
}

// Reads the tracked values of the open drawing again, if it changed since the last look.
// Returns how many results were recorded. Connection problems leave everything for later.
export async function checkTracked(scope: DrawingScope): Promise<number> {
  if (!scope.key) return 0;
  return queued(async () => {
    const file = await load(scope);
    if (!file.items.length) return 0;
    const now = Date.now();
    const expired = (item: Tracked) => now - Date.parse(item.createdAt) > KEEP_DAYS * 24 * 3600000;
    let recorded = 0;
    const done = new Set<Tracked>();
    if (file.lastState !== scope.state) {
      const handles = new Map<string, Tracked[]>();
      for (const item of file.items) handles.set(item.handle, [...handles.get(item.handle) ?? [], item]);
      for (const [handle, items] of handles) {
        let readings: Map<Tracked, Reading>;
        try { readings = await (items[0].objectKind === "alignment" ? readAlignment : readProfile)(handle, items); }
        catch (error) {
          // No drawing or no connection: try again later. Anything else: this object only.
          if (STOP.has(failureGuide(error instanceof Error ? error.message : String(error)).kind)) return recorded;
          continue;
        }
        for (const [item, reading] of readings) {
          if (reading.outcome) { await emit(item, reading.outcome); done.add(item); recorded++; continue; }
          if (reading.value !== undefined && Math.abs(reading.value - item.lastValue) > TOLERANCE) {
            item.lastValue = Math.round(reading.value * 10000) / 10000;
            item.modifiedAt = new Date().toISOString();
            await emit(item, "modified", item.lastValue);
            recorded++;
          }
        }
      }
      file.lastState = scope.state;
    }
    for (const item of file.items)
      if (!done.has(item) && expired(item)) {
        if (!item.modifiedAt) { await emit(item, "kept"); recorded++; }
        done.add(item);
      }
    file.items = file.items.filter(item => !done.has(item));
    // The MCP server process may have added items while this one was reading the drawing.
    const known = new Set([...file.items, ...done].map(item => item.id));
    file.items.push(...(await load(scope)).items.filter(item => !known.has(item.id)));
    if (file.items.length) await writeAtomic(fileOf(scope), JSON.stringify(file, null, 1));
    else await rm(fileOf(scope), { force: true });
    return recorded;
  });
}

// Files of drawings not opened for a long time: their items are closed as kept or left.
export function closeStaleTracking(): Promise<number> {
  return queued(async () => {
    let closed = 0;
    for (const name of await readdir(dir()).catch(() => [] as string[])) {
      const path = join(dir(), name);
      const file = JSON.parse(await readFile(path, "utf8").catch(() => "{\"items\":[]}")) as TrackFile;
      const now = Date.now();
      const stale = file.items.filter(item => now - Date.parse(item.createdAt) > KEEP_DAYS * 24 * 3600000);
      if (!stale.length) continue;
      for (const item of stale) if (!item.modifiedAt) { await emit(item, "kept"); closed++; }
      file.items = file.items.filter(item => !stale.includes(item));
      if (file.items.length) await writeAtomic(path, JSON.stringify(file, null, 1));
      else await rm(path, { force: true });
    }
    return closed;
  });
}
