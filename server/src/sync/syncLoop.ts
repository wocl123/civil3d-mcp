// 로컬 서비스의 뒤쪽 작업 (docs/데이터관리_설계.md §8). 한 번에 하나만 돌고, 답변을 붙잡지 않는다.
//   1) 열린 도면에서 추적 중인 값 다시 읽기 (사람이 고쳤는지)
//   2) 새 로그 → 보낼 묶음
//   3) 중앙 서버가 연결돼 있으면: 묶음 보내기 → 후보 보내기 → 중앙 지식 받기
//
// 도는 때: 서비스 시작 5초 뒤, 10분마다, 질문이 끝나고 10초 뒤. 정리(보관 기한)는 시작할 때와 6시간마다.

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

const START_DELAY_MS = 5000;
const INTERVAL_MS = 10 * 60 * 1000;
const AFTER_TURN_MS = 10000;
const CLEANUP_MS = 6 * 60 * 60 * 1000;

export type SyncResult = {
  tracked: number;     // 기록한 수정 추적 결과 수
  exported: number;    // 새로 만든 묶음 수
  blocked: number;     // 검사에 막힌 묶음 수
  sent: number;        // 보낸 묶음 수
  candidates: number;  // 보낸 후보 수
  official?: number;   // 받은 중앙 지식 버전
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
  setTimeout(() => { clean(); run(); }, START_DELAY_MS).unref();
  setInterval(run, INTERVAL_MS).unref();
  setInterval(clean, CLEANUP_MS).unref();
}

async function syncOnce(): Promise<SyncResult> {
  const result: SyncResult = { tracked: 0, exported: 0, blocked: 0, sent: 0, candidates: 0 };

  // 1) 수정 추적
  try {
    result.tracked = await checkTracked(await currentDrawingScope());
  } catch (error) {
    process.stderr.write(`MyCivil3DMcp tracking check failed: ${String(error)}\n`);
  }

  // 2) 로그 → 보낼 묶음 (서버 연결과 상관없이)
  const state = await loadState();
  const exported = await exportLogs(state);
  result.exported = exported.packages;
  result.blocked = exported.blocked;
  await saveState(state);

  // 3) 중앙 서버
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
      ? "중앙 서버가 이 PC의 토큰을 받지 않습니다. /중앙 연결로 다시 연결해 주세요."
      : (error instanceof Error ? error.message : String(error));
    result.error = state.lastError;
  }

  state.sentPackages = (state.sentPackages ?? 0) + result.sent;
  state.sentCandidates = (state.sentCandidates ?? 0) + result.candidates;
  await saveState(state);
  return result;
}

// 대기 중인 묶음을 오래된 것부터 보낸다.
//   - 서버는 같은 묶음 id를 한 번만 받으므로, 응답을 잃어 다시 보내도 문제없다.
//   - 서버가 안전하지 않다며 거절한(422) 묶음은 blocked 로 옮긴다.
//   - 연결 문제면 여기서 멈추고 나머지는 다음 번에 보낸다.
async function sendPending(central: CentralSettings, state: SyncState): Promise<number> {
  let sent = 0;
  const names = (await readdir(outboxDir("pending")).catch(() => [] as string[]))
    .filter(name => name.endsWith(".json"))
    .sort();

  for (const name of names) {
    const path = join(outboxDir("pending"), name);
    const text = await readFile(path, "utf8");
    try {
      await sendPackage(central, JSON.parse(text));
    } catch (error) {
      if (!(error instanceof CentralError) || error.status !== 422) throw error;
      const report = { reason: `서버 검사: ${error.message}`, blockedAt: new Date().toISOString(), package: JSON.parse(text) };
      await writeAtomic(join(outboxDir("blocked"), name), JSON.stringify(report, null, 1));
    }
    await rm(path, { force: true });
    sent++;
  }

  state.lastPush = new Date().toISOString();
  return sent;
}

// 아직 안 보낸 후보를 보낸다. 근거(사용자 말)는 빼고 가릴 낱말은 바꾼다.
// 그래도 검사에 걸리는 후보는 보내지 않고 남겨 둔다.
async function sendNewCandidates(central: CentralSettings): Promise<number> {
  const unsent = await unsentCandidates();
  if (!unsent.length) return 0;

  const terms = await privateTerms();
  const ready = unsent.map(item => ({
    id: item.id,
    body: {
      localId: item.id,
      title: blank(item.title, terms),
      content: blank(item.content, terms),
      ...(item.parameter ? { parameter: item.parameter } : {}),
      provider: item.provider,
      at: item.at.slice(0, 10),
      localStatus: item.status
    }
  })).filter(item => !leak(JSON.stringify(item.body), terms));
  if (!ready.length) return 0;

  await sendCandidates(central, ready.map(item => item.body));
  await markSubmitted(ready.map(item => item.id));
  return ready.length;
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
