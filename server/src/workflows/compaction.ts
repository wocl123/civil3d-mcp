import { askProvider, type Provider } from "../ai/aiCli.js";
import { addUsage } from "../ai/usage.js";
import { applySummary, unsummarized } from "./conversation.js";

// Like /compact: older turns are folded into a summary written by the AI, so a long
// conversation keeps its context at a bounded size. Runs after an answer is sent.
const TRIGGER_CHARS = 12000;
const KEEP_RECENT = 4;
const MAX_SUMMARY_CHARS = 2500;
const running = new Set<string>();

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

// Summarizes when the unsummarized turns exceed the trigger, or always when forced.
// Returns the number of turns folded in, or 0 when nothing was done.
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
    // The conversation stays as it is; long answers are still shortened when sent.
    process.stderr.write(`Conversation summary failed: ${String(error)}\n`);
    return 0;
  } finally {
    running.delete(id);
  }
}
