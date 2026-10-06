import { createHash } from "node:crypto";
import type { Config } from "./config.js";
import { PARAMETERS, validParameter } from "./parameters.js";
import type { CandidateRow, Official, Store } from "./store.js";

// What the reviewer decides on (docs/데이터관리_설계.md §6):
//   G-…  the same practice sent as a candidate from one or more installs, with how many
//   P-…  a setting the tracked changes of several installs point to ("통계 제안")
// Nothing reaches installs until the reviewer approves it; each approval or retraction
// publishes a new version of the central knowledge.
export type ReviewItem = {
  id: string; kind: "candidate" | "parameter"; content: string;
  parameter?: { key: string; value: number };
  support: { installs: number; cases: number }; evidence: string[];
};

const normalize = (text: string) => text.normalize("NFKC").toLocaleLowerCase("ko-KR").replace(/[\s\p{P}\p{S}]+/gu, "");
export const groupKey = (content: string) => createHash("sha256").update(normalize(content)).digest("hex").slice(0, 10);
const multiple = (value: number, step: number) => Math.abs(value / step - Math.round(value / step)) < 1e-6;

function candidateGroups(store: Store): ReviewItem[] {
  const groups = new Map<string, CandidateRow[]>();
  for (const row of store.candidates.filter(item => item.status === "pending"))
    groups.set(row.groupKey, [...groups.get(row.groupKey) ?? [], row]);
  const official = new Set(store.official.items.map(item => normalize(item.content)));
  return [...groups.entries()].filter(([, rows]) => !official.has(normalize(rows[0].content))).map(([key, rows]) => {
    const latest = rows.reduce((a, b) => (a.receivedAt > b.receivedAt ? a : b));
    const parameters = rows.map(row => row.parameter).filter((item): item is NonNullable<typeof item> => !!item);
    const parameter = parameters.sort((a, b) =>
      parameters.filter(item => item.key === b.key && item.value === b.value).length -
      parameters.filter(item => item.key === a.key && item.value === a.value).length)[0];
    return {
      id: `G-${key}`, kind: "candidate" as const, content: latest.content, ...(parameter ? { parameter } : {}),
      support: { installs: new Set(rows.map(row => row.installId)).size, cases: rows.length },
      evidence: rows.slice(-3).map(row => `${row.at ?? row.receivedAt.slice(0, 10)} · ${row.provider ?? "?"}${row.localStatus === "approved" ? " · 그 PC에서 승인함" : ""}`)
    };
  });
}

// For each setting, the largest step that people's own corrections keep landing on while
// the AI's values did not: e.g. radii changed from 123 to 130, 87 to 90, 248 to 250 → 10.
function parameterProposals(store: Store, config: Config): ReviewItem[] {
  const rejected = new Set(store.decisions.filter(item => item.decision === "reject").map(item => item.id));
  const items: ReviewItem[] = [];
  for (const [key, definition] of Object.entries(PARAMETERS)) {
    const cases = store.records.filter(row => row.record.type === "modification" && row.record.outcome === "modified" &&
      `${row.record.objectKind}.${row.record.property}` === definition.observe &&
      typeof row.record.aiValue === "number" && typeof row.record.userValue === "number");
    if (cases.length < config.minCases) continue;
    for (const step of [...definition.allowed].sort((a, b) => b - a).filter(value => value > 1)) {
      // Only changes of values that were not already on the step can show the preference.
      const eligible = cases.filter(row => !multiple(row.record.aiValue as number, step));
      const hits = eligible.filter(row => multiple(row.record.userValue as number, step));
      const installs = new Set(hits.map(row => row.installId)).size;
      const id = `P-${key}-${step}`;
      if (!eligible.length || hits.length / eligible.length < config.minShare || hits.length < config.minCases || installs < config.minInstalls) continue;
      if (store.official.parameters[key] === step || rejected.has(id)) break;
      items.push({
        id, kind: "parameter", parameter: { key, value: step },
        content: `${definition.label}를 ${step}(으)로 한다. 사람들이 AI 값을 고칠 때 ${step}의 배수로 맞췄다.`,
        support: { installs, cases: hits.length },
        evidence: [`AI 값이 ${step}의 배수가 아니던 수정 ${eligible.length}건 중 ${hits.length}건을 사람이 ${step}의 배수로 바꿈`,
          ...hits.slice(-2).map(row => `${row.record.aiValue} → ${row.record.userValue}`)]
      });
      break;
    }
  }
  return items;
}

export function reviewItems(store: Store, config: Config): ReviewItem[] {
  return [...parameterProposals(store, config), ...candidateGroups(store)]
    .sort((a, b) => b.support.installs - a.support.installs || b.support.cases - a.support.cases);
}

export class ReviewError extends Error {}

// Approves, rejects, or retracts one item; returns a short line for the reviewer.
export function decide(store: Store, config: Config, input: { id: string; decision: string; reason?: string; content?: string }): string {
  const { id, decision } = input;
  const reason = input.reason?.trim().slice(0, 200);
  if (decision === "retract") {
    const item = store.official.items.find(entry => entry.id === id);
    if (!item) throw new ReviewError(`${id}은(는) 중앙 지식에 없습니다.`);
    const next: Official = { ...store.official, items: store.official.items.filter(entry => entry !== item), parameters: { ...store.official.parameters } };
    if (item.parameter && next.parameters[item.parameter.key] === item.parameter.value) delete next.parameters[item.parameter.key];
    store.publish(next, { id, decision, reason });
    return `${id} 철회: ${item.content}`;
  }
  if (decision !== "approve" && decision !== "reject") throw new ReviewError("decision은 approve, reject, retract 중 하나입니다.");
  if (decision === "reject" && !reason) throw new ReviewError("반려에는 사유가 필요합니다.");
  const item = reviewItems(store, config).find(entry => entry.id === id);
  if (!item) throw new ReviewError(`${id}은(는) 검토 목록에 없습니다. /검토로 목록을 다시 보세요.`);
  const rows = item.kind === "candidate" ? store.candidates.filter(row => `G-${row.groupKey}` === id && row.status === "pending") : [];
  const now = new Date().toISOString();
  if (decision === "reject") {
    for (const row of rows) Object.assign(row, { status: "rejected", decidedAt: now, reason });
    store.saveCandidates();
    store.decide({ id, decision, reason });
    return `${id} 반려: ${item.content}`;
  }
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

// For /검토 보고: failures, tool speed, and what people did with AI results.
export function report(store: Store, config: Config) {
  const since = new Date(Date.now() - config.reportDays * 24 * 3600000).toISOString();
  const rows = store.records.filter(row => row.receivedAt >= since);
  const turns = rows.filter(row => row.record.type === "turn");
  const failedTurns: Record<string, number> = {};
  for (const row of turns) if (row.record.errorKind) failedTurns[String(row.record.errorKind)] = (failedTurns[String(row.record.errorKind)] ?? 0) + 1;
  const tools = new Map<string, { calls: number; failed: number; ms: number }>();
  for (const row of rows.filter(item => item.record.type === "tool")) {
    const name = String(row.record.tool ?? "?");
    const entry = tools.get(name) ?? { calls: 0, failed: 0, ms: 0 };
    entry.calls++; if (row.record.ok !== true) entry.failed++; entry.ms += Number(row.record.ms ?? 0);
    tools.set(name, entry);
  }
  const kept: Record<string, Record<string, number>> = {};
  for (const row of rows.filter(item => item.record.type === "modification")) {
    const key = `${row.record.objectKind}.${row.record.property}`;
    kept[key] ??= {};
    kept[key][String(row.record.outcome)] = (kept[key][String(row.record.outcome)] ?? 0) + 1;
  }
  return {
    days: config.reportDays, installs: new Set(rows.map(row => row.installId)).size, turns: turns.length, failedTurns,
    tools: [...tools.entries()].map(([tool, entry]) => ({ tool, calls: entry.calls, failed: entry.failed, avgMs: Math.round(entry.ms / entry.calls) }))
      .sort((a, b) => b.failed - a.failed || b.calls - a.calls),
    kept
  };
}
