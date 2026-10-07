// 검토자가 결정할 것 (docs/데이터관리_설계.md §6).
//   G-…  같은 관행을 여러(또는 한) 설치가 후보로 보낸 묶음. 몇 곳에서 보냈는지 함께.
//   P-…  여러 설치의 수정 추적 결과가 가리키는 설정값 ("통계 제안").
// 검토자가 승인하기 전에는 아무것도 설치로 가지 않는다. 승인·철회할 때마다 중앙 지식의 새 버전이 발행된다.

import { createHash } from "node:crypto";
import type { Config } from "./config.js";
import { PARAMETERS, validParameter } from "./parameters.js";
import type { CandidateRow, Official, Store } from "./store.js";

export type ReviewItem = {
  id: string;
  kind: "candidate" | "parameter";
  content: string;
  parameter?: { key: string; value: number };
  support: { installs: number; cases: number };   // 서로 다른 설치 수, 건수
  evidence: string[];
};

// 띄어쓰기·대소문자·문장부호를 빼고 비교한다("10 m 단위" = "10m단위").
const normalize = (text: string) => text.normalize("NFKC").toLocaleLowerCase("ko-KR").replace(/[\s\p{P}\p{S}]+/gu, "");
export const groupKey = (content: string) => createHash("sha256").update(normalize(content)).digest("hex").slice(0, 10);

// value가 step의 배수인지(소수 오차 허용).
const multiple = (value: number, step: number) => Math.abs(value / step - Math.round(value / step)) < 1e-6;

// 대기 중인 후보를 내용으로 묶는다. 이미 중앙 지식에 있는 내용은 뺀다.
function candidateGroups(store: Store): ReviewItem[] {
  const groups = new Map<string, CandidateRow[]>();
  for (const row of store.candidates.filter(item => item.status === "pending"))
    groups.set(row.groupKey, [...groups.get(row.groupKey) ?? [], row]);

  const official = new Set(store.official.items.map(item => normalize(item.content)));

  return [...groups.entries()]
    .filter(([, rows]) => !official.has(normalize(rows[0].content)))
    .map(([key, rows]) => {
      // 보여 줄 문구는 가장 최근에 받은 것, 설정값은 가장 많이 나온 것.
      const latest = rows.reduce((a, b) => (a.receivedAt > b.receivedAt ? a : b));
      const parameters = rows.map(row => row.parameter).filter((item): item is NonNullable<typeof item> => !!item);
      const parameter = parameters.sort((a, b) =>
        parameters.filter(item => item.key === b.key && item.value === b.value).length -
        parameters.filter(item => item.key === a.key && item.value === a.value).length)[0];

      return {
        id: `G-${key}`,
        kind: "candidate" as const,
        content: latest.content,
        ...(parameter ? { parameter } : {}),
        support: { installs: new Set(rows.map(row => row.installId)).size, cases: rows.length },
        evidence: rows.slice(-3).map(row =>
          `${row.at ?? row.receivedAt.slice(0, 10)} · ${row.provider ?? "?"}${row.localStatus === "approved" ? " · 그 PC에서 승인함" : ""}`)
      };
    });
}

// 설정값마다, 사람이 고친 값이 계속 맞춰지는 가장 큰 단위를 찾는다(AI 값은 그 단위가 아니었던 경우).
// 예: 반지름 123→130, 87→90, 248→250 → 10.
// 조건: 해당 수정의 minShare 이상, minCases 건 이상, minInstalls 곳 이상(config.json).
function parameterProposals(store: Store, config: Config): ReviewItem[] {
  const rejected = new Set(store.decisions.filter(item => item.decision === "reject").map(item => item.id));
  const items: ReviewItem[] = [];

  for (const [key, definition] of Object.entries(PARAMETERS)) {
    // 이 설정값과 관계있는 "사람이 고침" 기록들
    const cases = store.records.filter(row =>
      row.record.type === "modification" && row.record.outcome === "modified" &&
      `${row.record.objectKind}.${row.record.property}` === definition.observe &&
      typeof row.record.aiValue === "number" && typeof row.record.userValue === "number");
    if (cases.length < config.minCases) continue;

    // 큰 단위부터 본다(1은 제안하지 않는다).
    for (const step of [...definition.allowed].sort((a, b) => b - a).filter(value => value > 1)) {
      // AI 값이 이미 그 단위였던 수정은 선호를 보여 주지 못하므로 뺀다.
      const eligible = cases.filter(row => !multiple(row.record.aiValue as number, step));
      const hits = eligible.filter(row => multiple(row.record.userValue as number, step));
      const installs = new Set(hits.map(row => row.installId)).size;
      const id = `P-${key}-${step}`;

      const enough = eligible.length > 0 && hits.length / eligible.length >= config.minShare &&
        hits.length >= config.minCases && installs >= config.minInstalls;
      if (!enough) continue;

      // 이미 적용 중이거나 반려된 제안이면 더 작은 단위도 제안하지 않는다.
      if (store.official.parameters[key] === step || rejected.has(id)) break;

      items.push({
        id,
        kind: "parameter",
        parameter: { key, value: step },
        content: `${definition.label}를 ${step}(으)로 한다. 사람들이 AI 값을 고칠 때 ${step}의 배수로 맞췄다.`,
        support: { installs, cases: hits.length },
        evidence: [
          `AI 값이 ${step}의 배수가 아니던 수정 ${eligible.length}건 중 ${hits.length}건을 사람이 ${step}의 배수로 바꿈`,
          ...hits.slice(-2).map(row => `${row.record.aiValue} → ${row.record.userValue}`)
        ]
      });
      break;
    }
  }
  return items;
}

// 검토 목록: 통계 제안 + 후보 묶음, 지지한 설치 수가 많은 순.
export function reviewItems(store: Store, config: Config): ReviewItem[] {
  return [...parameterProposals(store, config), ...candidateGroups(store)]
    .sort((a, b) => b.support.installs - a.support.installs || b.support.cases - a.support.cases);
}

// 검토 결정이 잘못됐을 때(→ 409).
export class ReviewError extends Error {}

// 항목 하나를 승인 / 반려 / 철회한다. 검토자에게 보여 줄 한 줄을 돌려준다.
export function decide(store: Store, config: Config,
  input: { id: string; decision: string; reason?: string; content?: string }): string {
  const { id, decision } = input;
  const reason = input.reason?.trim().slice(0, 200);

  // ── 철회: 중앙 지식에서 빼고(그 항목이 정한 설정값도 빼고) 새 버전 발행.
  if (decision === "retract") {
    const item = store.official.items.find(entry => entry.id === id);
    if (!item) throw new ReviewError(`${id}은(는) 중앙 지식에 없습니다.`);
    const next: Official = {
      ...store.official,
      items: store.official.items.filter(entry => entry !== item),
      parameters: { ...store.official.parameters }
    };
    if (item.parameter && next.parameters[item.parameter.key] === item.parameter.value) delete next.parameters[item.parameter.key];
    store.publish(next, { id, decision, reason });
    return `${id} 철회: ${item.content}`;
  }

  if (decision !== "approve" && decision !== "reject") throw new ReviewError("decision은 approve, reject, retract 중 하나입니다.");
  if (decision === "reject" && !reason) throw new ReviewError("반려에는 사유가 필요합니다.");

  const item = reviewItems(store, config).find(entry => entry.id === id);
  if (!item) throw new ReviewError(`${id}은(는) 검토 목록에 없습니다. /검토로 목록을 다시 보세요.`);
  const rows = item.kind === "candidate"
    ? store.candidates.filter(row => `G-${row.groupKey}` === id && row.status === "pending")
    : [];
  const now = new Date().toISOString();

  // ── 반려: 묶음의 후보들을 반려로 표시. 중앙 지식은 그대로.
  if (decision === "reject") {
    for (const row of rows) Object.assign(row, { status: "rejected", decidedAt: now, reason });
    store.saveCandidates();
    store.decide({ id, decision, reason });
    return `${id} 반려: ${item.content}`;
  }

  // ── 승인: 중앙 지식에 K-번호로 더하고(검토자가 문구를 고쳤으면 그 문구로), 설정값도 정한 뒤 새 버전 발행.
  const content = input.content?.replace(/\s+/g, " ").trim().slice(0, 400) || item.content;
  const parameter = validParameter(item.parameter);
  const number = Math.max(0, ...store.official.items.map(entry => Number(entry.id.slice(2)) || 0)) + 1;
  const next: Official = {
    ...store.official,
    items: [...store.official.items, { id: `K-${number}`, content, approvedAt: now, ...(parameter ? { parameter } : {}), from: id }],
    parameters: { ...store.official.parameters, ...(parameter ? { [parameter.key]: parameter.value } : {}) }
  };
  for (const row of rows) Object.assign(row, { status: "approved", decidedAt: now });
  store.saveCandidates();
  store.publish(next, { id, decision, content: content !== item.content ? content : undefined });
  return `K-${number} 승인: ${content}`;
}

// /검토 보고: 최근 기간의 실패한 질문, 도구별 호출·실패·평균 시간, AI 결과를 사람이 어떻게 했는지.
export function report(store: Store, config: Config) {
  const since = new Date(Date.now() - config.reportDays * 24 * 3600000).toISOString();
  const rows = store.records.filter(row => row.receivedAt >= since);

  // 실패한 질문 (실패 종류별)
  const turns = rows.filter(row => row.record.type === "turn");
  const failedTurns: Record<string, number> = {};
  for (const row of turns) {
    if (row.record.errorKind) failedTurns[String(row.record.errorKind)] = (failedTurns[String(row.record.errorKind)] ?? 0) + 1;
  }

  // 도구별 통계
  const tools = new Map<string, { calls: number; failed: number; ms: number }>();
  for (const row of rows.filter(item => item.record.type === "tool")) {
    const name = String(row.record.tool ?? "?");
    const entry = tools.get(name) ?? { calls: 0, failed: 0, ms: 0 };
    entry.calls++;
    if (row.record.ok !== true) entry.failed++;
    entry.ms += Number(row.record.ms ?? 0);
    tools.set(name, entry);
  }

  // 수정 추적 결과 (속성별 → 결과별 개수)
  const kept: Record<string, Record<string, number>> = {};
  for (const row of rows.filter(item => item.record.type === "modification")) {
    const key = `${row.record.objectKind}.${row.record.property}`;
    kept[key] ??= {};
    kept[key][String(row.record.outcome)] = (kept[key][String(row.record.outcome)] ?? 0) + 1;
  }

  // 프로그램 버전별 질문 수와 실패율 (업데이트 뒤 나아졌는지)
  const versions = new Map<string, { turns: number; failed: number; installs: Set<string> }>();
  for (const row of turns) {
    const version = String(row.record.appVersion ?? "?");
    const entry = versions.get(version) ?? { turns: 0, failed: 0, installs: new Set<string>() };
    entry.turns++;
    if (row.record.errorKind) entry.failed++;
    entry.installs.add(row.installId);
    versions.set(version, entry);
  }

  return {
    days: config.reportDays,
    installs: new Set(rows.map(row => row.installId)).size,
    byVersion: [...versions.entries()]
      .map(([version, entry]) => ({ version, installs: entry.installs.size, turns: entry.turns, failed: entry.failed,
        failRate: Math.round((entry.failed / entry.turns) * 1000) / 10 }))
      .sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true })),
    turns: turns.length,
    failedTurns,
    tools: [...tools.entries()]
      .map(([tool, entry]) => ({ tool, calls: entry.calls, failed: entry.failed, avgMs: Math.round(entry.ms / entry.calls) }))
      .sort((a, b) => b.failed - a.failed || b.calls - a.calls),
    kept
  };
}
