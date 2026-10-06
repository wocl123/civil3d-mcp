// 수정 추적: 사람이 AI가 그린 것을 그대로 두는지.
//
// AI가 도면에 넣은 값(만든 선형의 곡선, 적용한 수정안)을 data/tracking/<도면>.json 에 기억해 두고
// 나중에 다시 읽는다.
//   - 사람이 바꾼 값은 AI가 어떻게 했어야 했는지 알려 주는 가장 분명한 신호다 → "modified"
//   - 14일 동안 그대로면 → "kept"
//   - 객체가 없어졌으면 → "deleted", 곡선 개수가 달라져 비교할 수 없으면 → "restructured"
// 결과는 data/logs/<날짜>/events.jsonl 에 "modification"으로 남고, 비식별 처리해 중앙 서버로 보낸다.
//
// 알 수 없는 것: 사람이 고친 뒤 저장하지 않고 닫은 경우.

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

const KEEP_DAYS = 14;        // 이 기간 그대로면 kept 로 끝낸다
const TOLERANCE = 0.001;     // 이보다 작은 차이는 같은 값

// 이런 실패면 이번에는 그만두고 다음에 다시 본다(도면이 없거나 연결이 안 됨).
const STOP = new Set(["old_plugin", "not_connected", "timeout", "disconnected", "no_drawing"]);

export type TrackedProperty = "radius" | "spiralLength" | "elevation" | "curveLength";
export type TrackConditions = { designSpeed?: number; roadClass?: string; region?: string; criteria?: string };

// 추적하는 값 하나.
export type Tracked = {
  id: string;
  source: "create" | "fix";          // 선형 생성 / 수정안 적용
  check?: string;
  objectKind: "alignment" | "profile";
  handle: string;
  curve?: number;                    // 선형: 곡선 그룹 번호
  at?: number;                       // 종단: PVI 측점
  property: TrackedProperty;
  aiValue: number;                   // AI가 넣은 값
  lastValue: number;                 // 마지막으로 읽은 값
  groups?: number;                   // 만든 선형의 곡선 그룹 수(곡선이 더해지거나 빠진 것을 알아채려고)
  conditions: TrackConditions;
  createdAt: string;
  modifiedAt?: string;               // 사람이 처음 고친 것을 본 시각
};

type TrackFile = { drawing: string; lastState?: string; items: Tracked[] };
type Outcome = "modified" | "kept" | "deleted" | "restructured";

const dir = () => join(dataDir(), "tracking");
const fileOf = (scope: DrawingScope) => join(dir(), `${hashKey(scope.key).slice(0, 16)}.json`);

async function load(scope: DrawingScope): Promise<TrackFile> {
  try {
    return JSON.parse(await readFile(fileOf(scope), "utf8")) as TrackFile;
  } catch {
    return { drawing: hashKey(scope.key).slice(0, 16), items: [] };
  }
}

// 이 프로세스 안의 파일 작업을 한 줄로 세운다.
let writing: Promise<unknown> = Promise.resolve();
const queued = <T>(work: () => Promise<T>): Promise<T> => {
  const next = writing.then(work);
  writing = next.catch(() => undefined);
  return next;
};

// AI가 방금 열린 도면에 넣은 값들을 기억한다.
export async function track(scope: DrawingScope, items: Omit<Tracked, "id" | "lastValue" | "createdAt">[]): Promise<void> {
  if (!scope.key || !items.length) return;

  await queued(async () => {
    const file = await load(scope);
    const now = new Date().toISOString();
    for (const item of items) {
      // 같은 값을 나중에 또 바꿨으면 앞 기록을 대신한다(AI의 마지막 값이 기준).
      file.items = file.items.filter(old =>
        !(old.handle === item.handle && old.property === item.property && old.curve === item.curve && old.at === item.at));
      const id = hashKey(item.handle, item.property, String(item.curve ?? item.at), now).slice(0, 12);
      file.items.push({ ...item, id, lastValue: item.aiValue, createdAt: now });
    }
    file.lastState = scope.state;
    await writeAtomic(fileOf(scope), JSON.stringify(file, null, 1));
  }).catch(error => process.stderr.write(`MyCivil3DMcp tracking was not saved: ${String(error)}\n`));
}

// 한 항목을 다시 읽은 결과: 지금 값, 또는 비교할 수 없는 이유(deleted / restructured).
type Reading = { value?: number; outcome?: Exclude<Outcome, "modified" | "kept"> };

// 객체를 찾지 못했다는 오류인지(→ 지워졌다).
const missing = (error: unknown) => /was not found|not found\.$/i.test(error instanceof Error ? error.message : String(error));

// 선형: 요소를 읽어 곡선 그룹 번호로 같은 곡선을 찾는다.
async function readAlignment(handle: string, items: Tracked[]): Promise<Map<Tracked, Reading>> {
  const out = new Map<Tracked, Reading>();
  let elements: AlignmentElement[];
  try {
    elements = await readSection<AlignmentElement>("alignment.section", { alignment: handle }, "elements");
  } catch (error) {
    if (!missing(error)) throw error;
    for (const item of items) out.set(item, { outcome: "deleted" });
    return out;
  }

  const groups = [...new Set(elements.filter(element => element.curveGroup > 0).map(element => element.curveGroup))];
  for (const item of items) {
    const group = elements.filter(element => element.curveGroup === item.curve);
    // 곡선 개수가 달라졌거나 그 곡선이 없으면 번호로 맞출 수 없다.
    if ((item.groups !== undefined && groups.length !== item.groups) || !group.length) {
      out.set(item, { outcome: "restructured" });
      continue;
    }
    // 반지름은 원곡선에서, 완화곡선 길이는 첫 완화곡선에서(없으면 0).
    const value = item.property === "radius"
      ? group.find(element => element.kind === "Arc")?.radius
      : group.find(element => element.kind === "Spiral")?.length ?? 0;
    out.set(item, value === undefined ? { outcome: "restructured" } : { value });
  }
  return out;
}

// 종단: PVI와 종단곡선을 읽어 측점으로 같은 PVI를 찾는다.
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
    const value = item.property === "elevation"
      ? pvis.find(pvi => near(pvi.station))?.elevation
      : curves.find(curve => near(curve.pviStation))?.length ?? 0;
    out.set(item, value === undefined ? { outcome: "restructured" } : { value });
  }
  return out;
}

// 결과를 작업 기록(events.jsonl)에 남긴다.
function emit(item: Tracked, outcome: Outcome, userValue?: number): Promise<void> {
  return logEvent({
    type: "modification",
    outcome,
    source: item.source,
    check: item.check,
    objectKind: item.objectKind,
    property: item.property,
    aiValue: item.aiValue,
    ...(userValue !== undefined ? { userValue } : {}),
    ageHours: Math.round((Date.now() - Date.parse(item.createdAt)) / 3600000),
    conditions: item.conditions
  });
}

// 열린 도면의 추적 값을 다시 읽는다. 지난번 이후 도면이 바뀌었을 때만 읽는다.
// 기록한 결과 수를 돌려준다. 연결 문제면 모두 다음으로 미룬다.
export async function checkTracked(scope: DrawingScope): Promise<number> {
  if (!scope.key) return 0;

  return queued(async () => {
    const file = await load(scope);
    if (!file.items.length) return 0;

    const now = Date.now();
    const expired = (item: Tracked) => now - Date.parse(item.createdAt) > KEEP_DAYS * 24 * 3600000;
    let recorded = 0;
    const done = new Set<Tracked>();   // 추적을 끝낸 항목

    // 1) 도면이 바뀌었으면 객체(핸들)별로 다시 읽어 비교한다.
    if (file.lastState !== scope.state) {
      const handles = new Map<string, Tracked[]>();
      for (const item of file.items) handles.set(item.handle, [...handles.get(item.handle) ?? [], item]);

      for (const [handle, items] of handles) {
        let readings: Map<Tracked, Reading>;
        try {
          readings = await (items[0].objectKind === "alignment" ? readAlignment : readProfile)(handle, items);
        } catch (error) {
          // 도면이 없거나 연결이 안 되면 다음에. 그 밖의 오류는 이 객체만 건너뛴다.
          if (STOP.has(failureGuide(error instanceof Error ? error.message : String(error)).kind)) return recorded;
          continue;
        }

        for (const [item, reading] of readings) {
          if (reading.outcome) {
            await emit(item, reading.outcome);
            done.add(item);
            recorded++;
            continue;
          }
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

    // 2) 기간이 지난 항목은 끝낸다(한 번도 안 고쳤으면 kept 로 남긴다).
    for (const item of file.items) {
      if (!done.has(item) && expired(item)) {
        if (!item.modifiedAt) { await emit(item, "kept"); recorded++; }
        done.add(item);
      }
    }
    file.items = file.items.filter(item => !done.has(item));

    // 3) 그사이 MCP 서버 프로세스가 새 항목을 더했을 수 있다. 디스크의 새 항목을 합친 뒤 저장한다.
    const known = new Set([...file.items, ...done].map(item => item.id));
    file.items.push(...(await load(scope)).items.filter(item => !known.has(item.id)));
    if (file.items.length) await writeAtomic(fileOf(scope), JSON.stringify(file, null, 1));
    else await rm(fileOf(scope), { force: true });

    return recorded;
  });
}

// 오래 열지 않은 도면의 추적 파일: 기간이 지난 항목을 끝낸다(한 번도 안 고쳤으면 kept).
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
