import type { Provider } from "../ai/types/Provider.js";

// The palette conversation's questions and answers, kept until 새 대화 (or until the
// service stops), so every question reaches the AI with the whole session behind it.
// Each request runs a fresh CLI, so this is its only context. When the turns grow
// long, older ones are folded into an AI-written summary (see compaction.ts).
// fixIds: fixes computed while answering; the user may agree to one of them next.
export type Turn = { provider: Provider; question: string; answer: string; fixIds?: string[] };

type Conversation = { turns: Turn[]; summary?: string; summarized: number; usedAt: number };

const MAX_STORED_ANSWER = 4000;
const MAX_CONVERSATIONS = 50;
const IDLE_MS = 12 * 60 * 60 * 1000;
// Turns not yet summarized are sent whole within this budget; beyond it older
// answers are shortened and the oldest kept as questions only, until a summary replaces them.
const FULL_BUDGET = 12000;
const SHORT_BUDGET = 6000;
const SHORT_ANSWER = 200;

const conversations = new Map<string, Conversation>();

export function isConversationId(value: unknown): value is string {
  return typeof value === "string" && /^[\w-]{8,64}$/.test(value);
}

function entry(id: string | undefined): Conversation | undefined {
  if (!id) return undefined;
  const found = conversations.get(id);
  if (found && Date.now() - found.usedAt > IDLE_MS) { conversations.delete(id); return undefined; }
  return found;
}

export function remember(id: string | undefined, turn: Turn): void {
  if (!id) return;
  const found = entry(id) ?? { turns: [], summarized: 0, usedAt: 0 };
  const answer = turn.answer.length > MAX_STORED_ANSWER ? turn.answer.slice(0, MAX_STORED_ANSWER) + "\n(이하 생략)" : turn.answer;
  found.turns.push({ ...turn, answer });
  found.usedAt = Date.now();
  conversations.delete(id);
  conversations.set(id, found);
  // Drop the least recently used conversations beyond the limit.
  for (const key of conversations.keys()) {
    if (conversations.size <= MAX_CONVERSATIONS) break;
    conversations.delete(key);
  }
}

export function forget(id: string): void {
  conversations.delete(id);
}

const turnText = (turn: Turn) => `Q: ${turn.question}\nA (${turn.provider}): ${turn.answer}`;

// Turns the summary does not cover yet, apart from the newest `keep`.
export function unsummarized(id: string | undefined, keep: number): { turns: Turn[]; upTo: number; summary?: string; chars: number } {
  const found = entry(id);
  if (!found) return { turns: [], upTo: 0, chars: 0 };
  const upTo = Math.max(found.summarized, found.turns.length - keep);
  const turns = found.turns.slice(found.summarized, upTo);
  return { turns, upTo, summary: found.summary, chars: turns.reduce((sum, turn) => sum + turnText(turn).length, 0) };
}

// Replaces turns up to upTo with the summary, unless the conversation changed meanwhile.
export function applySummary(id: string, summary: string, from: number, upTo: number): boolean {
  const found = entry(id);
  if (!found || found.summarized !== from || upTo > found.turns.length) return false;
  found.summary = summary;
  found.summarized = upTo;
  return true;
}

// Fixes shown in the last few answers: the only ones the AI may apply now.
export function offeredFixes(id: string | undefined, turns = 3): string[] {
  return (entry(id)?.turns.slice(-turns) ?? []).flatMap(turn => turn.fixIds ?? []);
}

export function summaryOf(id: string | undefined): string | undefined {
  return entry(id)?.summary;
}

export function status(id: string | undefined): { turns: number; summarized: number } {
  const found = entry(id);
  return { turns: found?.turns.length ?? 0, summarized: found?.summarized ?? 0 };
}

export function historyPrompt(id: string | undefined): string {
  const found = entry(id);
  if (!found || !found.turns.length) return "";
  const lines: string[] = [];
  const questionsOnly: string[] = [];
  let full = 0;
  let short = 0;
  for (const turn of found.turns.slice(found.summarized).reverse()) {
    const whole = turnText(turn);
    if (full + whole.length <= FULL_BUDGET) { lines.unshift(whole); full += whole.length; continue; }
    const brief = `Q: ${turn.question}\nA (${turn.provider}, 앞부분): ${turn.answer.slice(0, SHORT_ANSWER).replace(/\s+/g, " ")}…`;
    if (short + brief.length <= SHORT_BUDGET) { lines.unshift(brief); short += brief.length; continue; }
    questionsOnly.unshift(`- ${turn.question.slice(0, 100)}`);
  }
  return [
    "Earlier in this palette conversation (oldest first):",
    ...(found.summary ? [`Summary of the first ${found.summarized} turns:`, found.summary] : []),
    ...(questionsOnly.length ? ["Earlier questions (answers left out):", ...questionsOnly] : []),
    ...lines
  ].join("\n");
}
