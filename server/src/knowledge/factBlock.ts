import { readProposals } from "./knowledgeStore.js";
import type { FactProposal } from "./types/FactProposal.js";

// The skill asks every AI to end an answer with <facts>...</facts> when it
// confirmed something worth keeping. A plain text block works the same way for
// Claude, Codex, and Gemini, unlike a provider-specific memory tool.
export function splitFacts(text: string): { answer: string; proposals: FactProposal[] } {
  const blocks = [...text.matchAll(/<facts>([\s\S]*?)<\/facts>/gi)];
  const answer = text.replace(/<facts>[\s\S]*?<\/facts>/gi, "").trim();
  const last = blocks.at(-1)?.[1].replace(/```(?:json)?/gi, "").trim();
  if (!last) return { answer, proposals: [] };
  try {
    const parsed: unknown = JSON.parse(last);
    const list = Array.isArray(parsed) ? parsed : (parsed as { facts?: unknown })?.facts;
    return { answer, proposals: readProposals(list) };
  } catch {
    return { answer, proposals: [] };
  }
}
