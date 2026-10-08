// 관리자에게 보내는 기록 (docs/데이터관리_설계.md §3).
// 로그 한 줄에서 항목을 하나씩 골라 새로 만든다. 통째로 복사하는 것은 없다.
// 그래서 나중에 로그에 항목이 늘어도, 여기에 더하지 않는 한 PC 밖으로 나가지 않는다.
// 질문·답·도구 입력·변경 설명은 결과를 정제하는 데 필요해 보낸다(2026-10-07 결정).
// 보내기 전에 도면 이름·경로·파일·메일·사용자/PC 이름·키를 가린다(privacy.ts blank).

import { REGIONS, ROAD_CLASSES } from "../civil/alignmentRecord.js";
import { failureGuide } from "../errors/failureGuide.js";
import type { LogFile } from "../logs/workLog.js";
import { blank, hour } from "./privacy.js";

export type OutRecord = Record<string, unknown> & { type: "turn" | "tool" | "change" | "modification" | "feedback"; at: string };

type Line = Record<string, unknown>;

// ── 값 거르개: 모양이 맞을 때만 값을 받고, 아니면 undefined(빠짐).
const num = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;
// 도구 이름 (소문자_밑줄)
const name = (value: unknown) =>
  typeof value === "string" && /^[a-z][a-z_]{0,60}$/.test(value) ? value : undefined;
// 짧은 영문 낱말 (모델 이름, 종류 등)
const word = (value: unknown, max = 40) =>
  typeof value === "string" && /^[\w.-]+$/.test(value) && value.length <= max ? value : undefined;
// 코드가 만든 검토 이름 ("제19조 최소 평면곡선 반지름", "선형 생성"). 사람이 쓴 말은 아니다.
const check = (value: unknown) =>
  typeof value === "string" && /^[\p{L}\p{N} ·(),.%/①-⑳_-]{1,80}$/u.test(value) ? value : undefined;
// 요청·대화 id (무작위라 사람과 이어지지 않는다). 질문·도구·변경·평가를 서로 잇는 데 쓴다.
const id = (value: unknown) =>
  typeof value === "string" && /^[\w-]{8,64}$/.test(value) ? value : undefined;
// 자유 글: 가리고 max 글자까지
let terms: string[] = [];
const text = (value: unknown, max: number) => {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const masked = blank(value, terms);
  return masked.length > max ? masked.slice(0, max) + "…" : masked;
};
// 목록이면 개수만
const count = (value: unknown) => Array.isArray(value) ? value.length : 0;
// undefined 항목 빼기
const clean = <T extends Record<string, unknown>>(record: T): T =>
  Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined)) as T;

// 오류는 원문이 아니라 종류만 보낸다.
export function errorKind(message: unknown): string | undefined {
  if (typeof message !== "string" || !message) return undefined;
  if (/usage limit|rate limit|quota|429/i.test(message)) return "ai_limit";
  if (/account is not verified|Check its account login/.test(message)) return "ai_login";
  if (/returned no (final )?answer/.test(message)) return "ai_no_answer";
  const kind = failureGuide(message).kind;
  return kind === "unexpected" && /timed out|ETIMEDOUT/.test(message) ? "ai_timeout" : kind;
}

function usage(value: unknown) {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Record<string, unknown>;
  return clean({
    inputTokens: num(item.inputTokens),
    outputTokens: num(item.outputTokens),
    cachedInputTokens: num(item.cachedInputTokens)
  });
}

// 질문 1건. 질문·답 원문과 도면 이름은 넣지 않는다.
function turn(line: Line): OutRecord {
  const model = line.model as Record<string, unknown> | undefined;
  return clean({
    type: "turn" as const,
    at: hour(String(line.at)),
    id: id(line.requestId),
    conversation: id(line.conversation),
    question: text(line.question, 4000),
    answer: text(line.answer, 8000),
    kind: word(line.kind),
    provider: word(line.provider),
    model: word(model?.model),
    effort: word(model?.effort),
    ms: num(line.ms),
    cached: line.cached === true,
    tools: Array.isArray(line.tools) ? line.tools.map(name).filter(Boolean) : [],
    usage: usage(line.usage),
    counts: {
      recorded: count(line.recorded),
      candidates: count(line.candidates),
      fixes: count(line.fixes),
      applied: count(line.applied)
    },
    errorKind: errorKind(line.error)
  });
}

// 도구 호출 1건. 넘긴 값(input)과 오류 원문은 넣지 않는다.
function tool(line: Line): OutRecord {
  return clean({
    type: "tool" as const,
    at: hour(String(line.at)),
    turnId: id(line.requestId),
    tool: name(line.tool),
    input: text(line.input, 1500),
    ms: num(line.ms),
    ok: line.ok === true,
    outputChars: num(line.outputChars),
    images: num(line.images),
    errorKind: errorKind(line.error)
  });
}

// 도면 변경 시도 1건. 측점·핸들·선형 이름·수정안 제목은 넣지 않는다.
function change(line: Line): OutRecord {
  const result = line.result as Record<string, unknown> | undefined;
  const changes = Array.isArray(result?.changes) ? result.changes as Line[] : [];
  const created = result?.created as { curves?: unknown[] } | undefined;
  return clean({
    type: "change" as const,
    at: hour(String(line.at)),
    turnId: id(line.requestId),
    state: line.state === "applied" || line.state === "undone" ? line.state : "failed",
    title: text(line.title, 200),
    labels: text(Array.isArray(line.labels) ? line.labels.join("; ") : undefined, 1000),
    source: created || line.check === "선형 생성" ? "create" : "fix",
    check: check(line.check),
    changes: changes.map(item => clean({
      kind: word(item.kind), property: word(item.property), before: num(item.before), after: num(item.after)
    })),
    curves: created ? count(created.curves) : undefined,
    errorKind: errorKind(line.error)
  });
}

// 설계 조건: 정해진 목록에 있는 값만.
function conditions(value: unknown) {
  const item = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const oneOf = (list: readonly string[], text: unknown) => typeof text === "string" && list.includes(text) ? text : undefined;
  return clean({
    designSpeed: num(item.designSpeed),
    roadClass: oneOf(ROAD_CLASSES, item.roadClass),
    region: oneOf(REGIONS, item.region),
    criteria: typeof item.criteria === "string" && /^[\w가-힣.-]{1,60}$/.test(item.criteria) ? item.criteria : undefined
  });
}

// 수정 추적 결과 1건 (AI가 만든 값을 사람이 어떻게 했는지).
function event(line: Line): OutRecord | undefined {
  if (line.type !== "modification") return undefined;
  const outcomes = ["modified", "kept", "deleted", "restructured"];
  const properties = ["radius", "spiralLength", "elevation", "curveLength"];
  if (!outcomes.includes(String(line.outcome)) || !properties.includes(String(line.property))) return undefined;

  return clean({
    type: "modification" as const,
    at: hour(String(line.at)),
    outcome: String(line.outcome),
    source: line.source === "create" ? "create" : "fix",
    check: check(line.check),
    objectKind: line.objectKind === "profile" ? "profile" : "alignment",
    property: String(line.property),
    aiValue: num(line.aiValue),
    userValue: num(line.userValue),
    ageHours: num(line.ageHours),
    conditions: conditions(line.conditions)
  });
}

// 로그 파일 종류에 맞는 기록을 만든다.
// 프로그램 버전(0.1.0 형식 또는 dev). 버전별 실패율을 보려고 보낸다(개인정보 아님).
const appVersion = (value: unknown) =>
  typeof value === "string" && /^(\d+\.\d+\.\d+|dev)$/.test(value) ? value : undefined;

// 사용자가 답을 이상하다고 표시함(팔레트 👎). 이유는 가린다.
function feedback(line: Line): OutRecord | undefined {
  const turnId = id(line.requestId);
  if (!turnId) return undefined;
  return clean({ type: "feedback" as const, at: hour(String(line.at)), turnId, rating: line.rating === "good" ? "good" : "bad", reason: text(line.reason, 500) });
}

// privateTerms: 가릴 낱말(도면 이름, 사용자·PC 이름)
export function outRecord(file: LogFile, line: Line, privateTerms: string[] = []): OutRecord | undefined {
  if (typeof line.at !== "string") return undefined;
  terms = privateTerms;
  const record = file === "turns.jsonl" ? turn(line)
    : file === "tools.jsonl" ? tool(line)
    : file === "changes.jsonl" ? change(line)
    : file === "events.jsonl" ? event(line)
    : file === "feedback.jsonl" ? feedback(line)
    : undefined;
  return record && clean({ ...record, appVersion: appVersion(line.appVersion) });
}
