// 팔레트 대화 기억 (서비스 메모리 안).
// "새 대화"를 누르거나 서비스가 꺼질 때까지 질문·답을 모아 두고, 질문마다 앞 대화를 함께 AI에 보낸다.
// 요청마다 CLI를 새로 띄우므로 이것이 AI가 가진 유일한 앞 대화다.
// 대화가 길어지면 오래된 부분은 AI가 쓴 요약으로 접는다(compaction.ts).

import type { Provider } from "../ai/types/Provider.js";

// 대화 한 턴. fixIds: 이 답에서 계산한 수정안 id(다음 질문에서 사용자가 그중 하나에 동의할 수 있다).
export type Turn = { provider: Provider; question: string; answer: string; fixIds?: string[] };

// summarized: 요약이 앞에서부터 몇 턴을 대신하는지.
type Conversation = { turns: Turn[]; summary?: string; summarized: number; usedAt: number };

const MAX_STORED_ANSWER = 4000;        // 기억하는 답 길이
const MAX_CONVERSATIONS = 50;          // 기억하는 대화 수(오래 안 쓴 것부터 버림)
const IDLE_MS = 12 * 60 * 60 * 1000;   // 12시간 안 쓰면 버림

// 아직 요약되지 않은 턴은 FULL_BUDGET 안에서 통째로 보낸다.
// 넘치면 오래된 답은 앞부분만(SHORT_BUDGET 안에서), 그보다 오래된 것은 질문만 보낸다(요약이 대신할 때까지).
const FULL_BUDGET = 12000;
const SHORT_BUDGET = 6000;
const SHORT_ANSWER = 200;

const conversations = new Map<string, Conversation>();

export function isConversationId(value: unknown): value is string {
  return typeof value === "string" && /^[\w-]{8,64}$/.test(value);
}

// 대화 하나. 오래 안 썼으면 버리고 undefined.
function entry(id: string | undefined): Conversation | undefined {
  if (!id) return undefined;
  const found = conversations.get(id);
  if (found && Date.now() - found.usedAt > IDLE_MS) {
    conversations.delete(id);
    return undefined;
  }
  return found;
}

// 턴 하나를 더한다.
export function remember(id: string | undefined, turn: Turn): void {
  if (!id) return;
  const found = entry(id) ?? { turns: [], summarized: 0, usedAt: 0 };
  const answer = turn.answer.length > MAX_STORED_ANSWER ? turn.answer.slice(0, MAX_STORED_ANSWER) + "\n(이하 생략)" : turn.answer;
  found.turns.push({ ...turn, answer });
  found.usedAt = Date.now();

  // 맨 뒤로 옮겨 "최근 사용" 순서를 유지하고, 개수가 넘치면 가장 오래 안 쓴 것부터 버린다.
  conversations.delete(id);
  conversations.set(id, found);
  for (const key of conversations.keys()) {
    if (conversations.size <= MAX_CONVERSATIONS) break;
    conversations.delete(key);
  }
}

export function forget(id: string): void {
  conversations.delete(id);
}

const turnText = (turn: Turn) => `Q: ${turn.question}\nA (${turn.provider}): ${turn.answer}`;

// 요약이 아직 대신하지 않는 턴들(최신 keep개는 빼고).
export function unsummarized(id: string | undefined, keep: number):
  { turns: Turn[]; upTo: number; summary?: string; chars: number } {
  const found = entry(id);
  if (!found) return { turns: [], upTo: 0, chars: 0 };
  const upTo = Math.max(found.summarized, found.turns.length - keep);
  const turns = found.turns.slice(found.summarized, upTo);
  return { turns, upTo, summary: found.summary, chars: turns.reduce((sum, turn) => sum + turnText(turn).length, 0) };
}

// upTo 턴까지를 요약으로 바꾼다. 그사이 대화가 바뀌었으면(다른 요약이 먼저 됨) 하지 않는다.
export function applySummary(id: string, summary: string, from: number, upTo: number): boolean {
  const found = entry(id);
  if (!found || found.summarized !== from || upTo > found.turns.length) return false;
  found.summary = summary;
  found.summarized = upTo;
  return true;
}

// 최근 몇 답에서 보여 준 수정안 id. 지금 AI가 적용할 수 있는 것은 이것뿐이다.
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

// 질문 앞에 붙일 앞 대화(오래된 것부터). 요약 → 질문만 남긴 턴 → 앞부분만 남긴 턴 → 통째인 턴.
// (AI가 읽는 문장이라 영어로 둔다.)
export function historyPrompt(id: string | undefined): string {
  const found = entry(id);
  if (!found || !found.turns.length) return "";

  const lines: string[] = [];
  const questionsOnly: string[] = [];
  let full = 0;
  let short = 0;

  // 최신 턴부터 예산 안에 담는다.
  for (const turn of found.turns.slice(found.summarized).reverse()) {
    const whole = turnText(turn);
    if (full + whole.length <= FULL_BUDGET) {
      lines.unshift(whole);
      full += whole.length;
      continue;
    }
    const brief = `Q: ${turn.question}\nA (${turn.provider}, 앞부분): ${turn.answer.slice(0, SHORT_ANSWER).replace(/\s+/g, " ")}…`;
    if (short + brief.length <= SHORT_BUDGET) {
      lines.unshift(brief);
      short += brief.length;
      continue;
    }
    questionsOnly.unshift(`- ${turn.question.slice(0, 100)}`);
  }

  return [
    "Earlier in this palette conversation (oldest first):",
    ...(found.summary ? [`Summary of the first ${found.summarized} turns:`, found.summary] : []),
    ...(questionsOnly.length ? ["Earlier questions (answers left out):", ...questionsOnly] : []),
    ...lines
  ].join("\n");
}
