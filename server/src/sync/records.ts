import { REGIONS, ROAD_CLASSES } from "../civil/alignmentRecord.js";
import { failureGuide } from "../errors/failureGuide.js";
import type { LogFile } from "../logs/workLog.js";
import { hour } from "./privacy.js";

// The records sent to the central server (docs/데이터관리_설계.md §3). Each is built
// field by field from a local log line; nothing is copied over as a whole, so a field
// added to the local logs later never leaves this PC unless it is added here.
export type OutRecord = Record<string, unknown> & { type: "turn" | "tool" | "change" | "modification"; at: string };

type Line = Record<string, unknown>;
const num = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : undefined;
const name = (value: unknown) => typeof value === "string" && /^[a-z][a-z_]{0,60}$/.test(value) ? value : undefined;
const word = (value: unknown, max = 40) => typeof value === "string" && /^[\w.-]+$/.test(value) && value.length <= max ? value : undefined;
// Code-made check names, such as "제19조 최소 평면곡선 반지름" or "선형 생성"; never people's words.
const check = (value: unknown) => typeof value === "string" && /^[\p{L}\p{N} ·(),.%/①-⑳_-]{1,80}$/u.test(value) ? value : undefined;
const count = (value: unknown) => Array.isArray(value) ? value.length : 0;
const clean = <T extends Record<string, unknown>>(record: T): T =>
  Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined)) as T;

// What kind of failure a message was, never the message itself.
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
  return clean({ inputTokens: num(item.inputTokens), outputTokens: num(item.outputTokens), cachedInputTokens: num(item.cachedInputTokens) });
}

function turn(line: Line): OutRecord {
  const model = line.model as Record<string, unknown> | undefined;
  return clean({
    type: "turn" as const, at: hour(String(line.at)), kind: word(line.kind), provider: word(line.provider),
    model: word(model?.model), effort: word(model?.effort), ms: num(line.ms), cached: line.cached === true,
    tools: Array.isArray(line.tools) ? line.tools.map(name).filter(Boolean) : [],
    usage: usage(line.usage),
    counts: { recorded: count(line.recorded), candidates: count(line.candidates), fixes: count(line.fixes), applied: count(line.applied) },
    errorKind: errorKind(line.error)
  });
}

function tool(line: Line): OutRecord {
  return clean({
    type: "tool" as const, at: hour(String(line.at)), tool: name(line.tool), ms: num(line.ms), ok: line.ok === true,
    outputChars: num(line.outputChars), images: num(line.images), errorKind: errorKind(line.error)
  });
}

function change(line: Line): OutRecord {
  const result = line.result as Record<string, unknown> | undefined;
  const changes = Array.isArray(result?.changes) ? result.changes as Line[] : [];
  const created = result?.created as { curves?: unknown[] } | undefined;
  return clean({
    type: "change" as const, at: hour(String(line.at)), state: line.state === "applied" ? "applied" : "failed",
    source: created || line.check === "선형 생성" ? "create" : "fix", check: check(line.check),
    changes: changes.map(item => clean({ kind: word(item.kind), property: word(item.property), before: num(item.before), after: num(item.after) })),
    curves: created ? count(created.curves) : undefined,
    errorKind: errorKind(line.error)
  });
}

function conditions(value: unknown) {
  const item = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const oneOf = (list: readonly string[], text: unknown) => typeof text === "string" && list.includes(text) ? text : undefined;
  return clean({
    designSpeed: num(item.designSpeed), roadClass: oneOf(ROAD_CLASSES, item.roadClass), region: oneOf(REGIONS, item.region),
    criteria: typeof item.criteria === "string" && /^[\w가-힣.-]{1,60}$/.test(item.criteria) ? item.criteria : undefined
  });
}

function event(line: Line): OutRecord | undefined {
  if (line.type !== "modification") return undefined;
  const outcomes = ["modified", "kept", "deleted", "restructured"];
  const properties = ["radius", "spiralLength", "elevation", "curveLength"];
  if (!outcomes.includes(String(line.outcome)) || !properties.includes(String(line.property))) return undefined;
  return clean({
    type: "modification" as const, at: hour(String(line.at)), outcome: String(line.outcome),
    source: line.source === "create" ? "create" : "fix", check: check(line.check),
    objectKind: line.objectKind === "profile" ? "profile" : "alignment", property: String(line.property),
    aiValue: num(line.aiValue), userValue: num(line.userValue), ageHours: num(line.ageHours), conditions: conditions(line.conditions)
  });
}

export function outRecord(file: LogFile, line: Line): OutRecord | undefined {
  if (typeof line.at !== "string") return undefined;
  switch (file) {
    case "turns.jsonl": return turn(line);
    case "tools.jsonl": return tool(line);
    case "changes.jsonl": return change(line);
    case "events.jsonl": return event(line);
  }
}
