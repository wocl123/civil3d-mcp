// 답변 끝의 <facts>...</facts> 블록을 떼어 낸다.
// 스킬은 모든 AI에게, 기억할 만한 것을 확인했으면 답 끝에 이 블록을 붙이라고 한다.
// AI마다 다른 메모리 도구 대신 평범한 글자 블록을 쓰므로 Claude, Codex, Gemini가 똑같이 동작한다.

import { readProposals } from "./knowledgeStore.js";
import type { FactProposal } from "./types/FactProposal.js";

export function splitFacts(text: string): { answer: string; proposals: FactProposal[] } {
  // 블록은 모두 답에서 빼고, 마지막 블록만 읽는다(```json 울타리는 걷어 낸다).
  const blocks = [...text.matchAll(/<facts>([\s\S]*?)<\/facts>/gi)];
  const answer = text.replace(/<facts>[\s\S]*?<\/facts>/gi, "").trim();
  const last = blocks.at(-1)?.[1].replace(/```(?:json)?/gi, "").trim();
  if (!last) return { answer, proposals: [] };

  try {
    // 배열이거나 { facts: [...] } 모양을 받는다.
    const parsed: unknown = JSON.parse(last);
    const list = Array.isArray(parsed) ? parsed : (parsed as { facts?: unknown })?.facts;
    return { answer, proposals: readProposals(list) };
  } catch {
    return { answer, proposals: [] };
  }
}
