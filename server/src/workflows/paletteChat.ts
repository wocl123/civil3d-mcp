import { randomUUID } from "node:crypto";
import { askProvider, type Provider } from "../ai/aiCli.js";
import { appliedFor, fixesFor } from "../changes/changeStore.js";
import { paletteModel, paletteVersion } from "../ai/paletteWorkspace.js";
import { addUsage, getUsageTotals } from "../ai/usage.js";
import type { TokenUsage } from "../ai/types/TokenUsage.js";
import { FactsFilter } from "./factsFilter.js";
import { toolLabel } from "./toolLabels.js";
import { historyPrompt, offeredFixes, remember, status, summaryOf } from "./conversation.js";
import { compactConversation } from "./compaction.js";
import { candidateCommand } from "./candidateCommands.js";
import { drawingOutline } from "../civil/drawingOutline.js";
import { selectionOutline } from "../civil/drawingSelection.js";
import { splitFacts } from "../knowledge/factBlock.js";
import { addCandidates } from "../knowledge/candidateStore.js";
import { appendFacts, knowledgePrompt, readKnowledge } from "../knowledge/knowledgeStore.js";
import { clip, logTurn } from "../logs/workLog.js";
import { currentDrawingScope } from "../memory/drawingScope.js";
import { findAnswer, hashKey, normalizeQuestion, saveAnswer } from "../memory/memoryStore.js";

const NO_USAGE: TokenUsage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, costUsd: 0 };

// What the palette sees while an answer is being made.
export type ChatProgress = { type: "progress"; text: string } | { type: "delta"; text: string };

// Answers a palette question. The same question to the same AI while the drawing
// is unchanged is answered from memory; any drawing edit changes its revision, and
// any change to the skill, rules, or model changes the key.
// Otherwise the AI gets the drawing's knowledge, so it does not ask or look up
// settled facts again, and any facts it newly confirms are added to that knowledge.
// Practices the user states that hold beyond the drawing become knowledge candidates
// for people to approve with /후보 (see candidateStore.ts).
// The outline of Civil objects saves the AI a listing call before most answers, and the
// current selection lets the user point at objects before asking.
// The conversation so far goes with the question so follow-ups make sense; it is
// part of the reuse key, so a follow-up is reused only after the same conversation.
// After each answer, a long conversation is summarized in the background; "/compact"
// summarizes it at once. Every turn is written to the work log (logs/workLog.ts).

export async function answerChat(provider: Provider, message: string,
  onProgress?: (event: ChatProgress) => void, conversation?: string) {
  const question = message.trim();
  const started = Date.now();
  const requestId = randomUUID();
  const log = (entry: Record<string, unknown>) => logTurn({
    requestId, conversation, provider, question: clip(question, 2000), ms: Date.now() - started, ...entry
  });

  const command = await candidateCommand(question, conversation);
  if (command) {
    await log({ kind: "candidates", answer: clip(command) });
    return { provider, answer: command, usage: NO_USAGE, totals: getUsageTotals(provider), cached: false, recorded: [], conversation: status(conversation) };
  }
  if (question === "/compact") {
    const result = await compactNow(provider, conversation);
    await log({ kind: "compact", answer: clip(result.answer) });
    return result;
  }

  // The selection is part of the reuse key: "이걸로 선형 만들어줘" means another object
  // once the user selects another, while the drawing revision stays the same.
  const [scope, selection] = await Promise.all([currentDrawingScope(), selectionOutline()]);
  const earlier = historyPrompt(conversation);
  const key = hashKey(normalizeQuestion(question), await paletteVersion(provider), ...(earlier ? [earlier] : []), ...(selection ? [selection] : []));

  const cached = await findAnswer("chat", provider, key, scope);
  if (cached) {
    remember(conversation, { provider, question, answer: cached.answer });
    void compactConversation(conversation, provider);
    await log({ kind: "chat", drawing: scope.label, cached: true, answer: clip(cached.answer) });
    return {
      provider, answer: cached.answer, usage: NO_USAGE, totals: getUsageTotals(provider),
      cached: true, cachedAt: new Date(cached.createdAt).toISOString(), savedUsage: cached.usage, recorded: [],
      conversation: status(conversation)
    };
  }

  const [knowledge, outline] = await Promise.all([readKnowledge(scope).then(knowledgePrompt), drawingOutline()]);
  const prompt = [
    ...(outline ? [outline, ""] : []),
    ...(selection ? [selection, ""] : []),
    ...(knowledge ? [`Drawing knowledge for ${scope.label}:`, knowledge, ""] : []),
    ...(earlier ? [earlier, ""] : []),
    "Question:",
    question
  ].join("\n");

  const filter = new FactsFilter();
  const tools: string[] = [];
  onProgress?.({ type: "progress", text: "생각하는 중" });
  let result: Awaited<ReturnType<typeof askProvider>>;
  try {
    result = await askProvider(provider, prompt, {
      tools: true,
      requestId,
      offeredFixes: offeredFixes(conversation),
      onEvent: event => {
        if (event.type === "tool") {
          tools.push(event.name);
          onProgress?.({ type: "progress", text: toolLabel(event.name) });
        } else {
          const text = filter.push(event.text);
          if (text && onProgress) onProgress({ type: "delta", text });
        }
      }
    });
  } catch (error) {
    await log({ kind: "chat", drawing: scope.label, tools, error: clip(error instanceof Error ? error.message : String(error), 1000) });
    throw error;
  }
  const totals = addUsage(provider, result.usage);
  const { answer, proposals } = splitFacts(result.answer);
  const general = proposals.filter(proposal => proposal.scope === "general");
  const [recorded, candidates] = await Promise.all([
    appendFacts(scope, proposals.filter(proposal => proposal.scope !== "general"), provider),
    addCandidates(general, scope.label, provider)
  ]);
  // Drawing changes made in this request, and fixes computed in it. The fix ids stay out
  // of the shown answer but go with it into the conversation, so the user can agree to
  // one next. Answers that changed the drawing or offered fixes are not reused: a replay
  // would neither apply anything nor carry the fix ids.
  const [applied, fixes] = await Promise.all([appliedFor(requestId), fixesFor(requestId)]);
  if (!applied.length && !fixes.length) await saveAnswer({
    kind: "chat", provider, key, question, scope: scope.key, state: scope.state, answer, usage: result.usage
  });
  const fixNote = fixes.length ? "\n[이 답의 수정안 id] " + fixes.map(fix =>
    `${fix.id}: ${fix.target} · ${fix.title}${fix.applicable ? "" : " (자동 적용 불가)"}`).join("; ") : "";
  const appliedNote = applied.length ? "\n[도면에 적용함] " + applied.map(entry => entry.labels.join(", ")).join("; ") : "";
  remember(conversation, { provider, question, answer: answer + appliedNote + fixNote, fixIds: fixes.map(fix => fix.id) });
  void compactConversation(conversation, provider);
  await log({
    kind: "chat", drawing: scope.label, model: await paletteModel(provider), tools, answer: clip(answer),
    applied: applied.map(entry => entry.labels.join(", ")), fixes: fixes.map(fix => fix.id), recorded, candidates, usage: result.usage
  });
  return {
    provider, answer, usage: result.usage, totals, cached: false, recorded, candidates, conversation: status(conversation),
    applied: applied.map(entry => ({ title: entry.title, target: entry.target, labels: entry.labels }))
  };
}

async function compactNow(provider: Provider, conversation: string | undefined) {
  const folded = await compactConversation(conversation, provider, true);
  const state = status(conversation);
  const answer = folded
    ? `앞 대화 ${state.summarized}개를 요약했습니다. 이후 질문에는 이 요약과 최근 대화가 함께 전달됩니다.

### 요약
${summaryOf(conversation) ?? ""}`
    : state.turns <= 1 ? "요약할 대화가 아직 없습니다." : "요약하지 못했습니다. 대화는 그대로 이어집니다.";
  return { provider, answer, usage: NO_USAGE, totals: getUsageTotals(provider), cached: false, recorded: [], conversation: state };
}
