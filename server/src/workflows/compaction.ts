// 대화 요약 (/compact 와 같은 일).
// 오래된 턴을 AI가 쓴 요약으로 접어, 긴 대화도 문맥 크기가 일정하게 유지되게 한다. 답을 보낸 뒤에 돈다.

import { askProvider, type Provider } from "../ai/aiCli.js";
import { addUsage } from "../ai/usage.js";
import { applySummary, unsummarized } from "./conversation.js";

const TRIGGER_CHARS = 12000;     // 요약 안 된 턴이 이만큼 쌓이면 요약한다
const KEEP_RECENT = 4;           // 최신 4턴은 요약하지 않고 그대로 둔다
const MAX_SUMMARY_CHARS = 2500;

// 대화마다 요약은 한 번에 하나만.
const running = new Set<string>();

// 요약을 부탁하는 프롬프트(AI가 읽으므로 영어).
function summaryPrompt(previous: string | undefined, turns: string): string {
  return [
    "Summarize this Civil 3D palette conversation so the conversation can continue from the summary alone.",
    "Return only the summary in Korean, as \"- \" bullets, at most 2000 characters, with no facts block.",
    "Keep: drawing and object names (alignments, profiles, layers), conditions the user gave (design speed, area, criteria),",
    "decisions and conclusions with their key values, open questions, and what the user asked to do next.",
    "Leave out: tables of values that tools can read again, greetings, and repeated content.",
    "",
    ...(previous ? ["Summary so far:", previous, ""] : []),
    "Turns to add:",
    turns
  ].join("\n");
}

// 요약 안 된 턴이 기준을 넘으면(force면 언제나) 요약한다.
// 요약에 접은 턴 수를 돌려준다. 하지 않았으면 0.
export async function compactConversation(id: string | undefined, provider: Provider, force = false): Promise<number> {
  if (!id || running.has(id)) return 0;
  const pending = unsummarized(id, force ? 1 : KEEP_RECENT);
  if (!pending.turns.length || (!force && pending.chars < TRIGGER_CHARS)) return 0;

  running.add(id);
  try {
    const from = pending.upTo - pending.turns.length;
    const turns = pending.turns.map(turn => `Q: ${turn.question}\nA: ${turn.answer}`).join("\n\n");
    const result = await askProvider(provider, summaryPrompt(pending.summary, turns), { tools: false });
    addUsage(provider, result.usage);
    const summary = result.answer.trim().slice(0, MAX_SUMMARY_CHARS);
    return summary && applySummary(id, summary, from, pending.upTo) ? pending.turns.length : 0;
  } catch (error) {
    // 실패하면 대화는 그대로 둔다(보낼 때 긴 답은 어차피 줄여서 보낸다).
    process.stderr.write(`Conversation summary failed: ${String(error)}\n`);
    return 0;
  } finally {
    running.delete(id);
  }
}
