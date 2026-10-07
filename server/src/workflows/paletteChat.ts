import { fixCard, settleOperations } from "../changes/operations.js";
// 팔레트 질문 하나에 답한다. 순서:
//   1) 명령(/중앙, /검토, /설정값, /후보, /compact)이면 AI 없이 바로 답한다.
//   2) 도면 상태·선택을 읽는다. 같은 AI·같은 질문·같은 도면 상태면 저장한 답을 쓴다.
//      (도면을 고치면 리비전이 바뀌고, 스킬·규칙·모델·설정값이 바뀌면 키가 바뀐다.)
//   3) 아니면 프롬프트를 만든다: Civil 객체 목록 + 선택 + 도면 지식 + 앞 대화 + 질문.
//      - 객체 목록이 있으면 AI가 목록 도구를 먼저 부르지 않아도 된다.
//      - 도면 지식이 있으면 이미 정해진 것을 다시 묻거나 찾지 않는다.
//   4) AI 답에서 <facts>를 떼어 도면 지식(또는 일반 관행이면 지식 후보)으로 저장한다.
//   5) 대화에 남기고, 길어지면 뒤에서 요약하고, 작업 기록을 쓰고, 조금 뒤 동기화한다.
// 답하기 전에는 이 도면에서 AI가 넣었던 값을 뒤에서 다시 읽어 사람이 고쳤는지 본다.

import { randomUUID } from "node:crypto";
import { askProvider, type Provider } from "../ai/aiCli.js";
import { appliedFor, fixesFor } from "../changes/changeStore.js";
import { paletteModel, paletteVersion } from "../ai/paletteWorkspace.js";
import { addUsage, getUsageTotals } from "../ai/usage.js";
import type { TokenUsage } from "../ai/types/TokenUsage.js";
import { dropSelfNotes, FactsFilter } from "./factsFilter.js";
import { toolLabel } from "./toolLabels.js";
import { historyPrompt, offeredFixes, remember, status, summaryOf } from "./conversation.js";
import { compactConversation } from "./compaction.js";
import { candidateCommand } from "./candidateCommands.js";
import { centralCommand } from "./centralCommands.js";
import { addTerms } from "../data/terms.js";
import { syncSoon } from "../sync/syncLoop.js";
import { checkTracked } from "../tracking/tracker.js";
import { drawingOutline } from "../civil/drawingOutline.js";
import { readSelection } from "../civil/drawingSelection.js";
import { splitFacts } from "../knowledge/factBlock.js";
import { addCandidates } from "../knowledge/candidateStore.js";
import { appendFacts, knowledgePrompt, readKnowledge } from "../knowledge/knowledgeStore.js";
import { clip, logTurn } from "../logs/workLog.js";
import { currentDrawingScope } from "../memory/drawingScope.js";
import { findAnswer, hashKey, normalizeQuestion, saveAnswer } from "../memory/memoryStore.js";

const NO_USAGE: TokenUsage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, costUsd: 0 };

// 답을 만드는 동안 팔레트가 받는 것: 진행 문구(progress), 답 글자 조각(delta).
export type ChatProgress = { type: "progress"; text: string } | { type: "delta"; text: string };

export async function answerChat(provider: Provider, message: string,
  onProgress?: (event: ChatProgress) => void, conversation?: string, signal?: AbortSignal) {
  const question = message.trim();
  const started = Date.now();
  const requestId = randomUUID();

  // /중앙 연결, /중앙 검토자 에 들어간 키는 작업 기록에 남기지 않는다.
  const logged = /^\/중앙\s+(연결|검토자)/.test(question) ? question.replace(/^(\/중앙\s+\S+).*$/s, "$1 <가림>") : question;
  const log = (entry: Record<string, unknown>) => logTurn({
    requestId, conversation, provider, question: clip(logged, 2000), ms: Date.now() - started, ...entry
  });

  // ── 1) 명령
  const command = await centralCommand(question, conversation) ?? await candidateCommand(question, conversation);
  if (command) {
    await log({ kind: "candidates", answer: clip(command) });
    return {
      provider, answer: command, usage: NO_USAGE, totals: getUsageTotals(provider),
      cached: false, recorded: [], conversation: status(conversation)
    };
  }
  if (question === "/compact") {
    const result = await compactNow(provider, conversation);
    await log({ kind: "compact", answer: clip(result.answer) });
    return result;
  }

  // ── 2) 도면 상태와 선택. 선택도 재사용 키에 들어간다:
  //       "이걸로 선형 만들어줘"는 도면이 그대로여도 다른 객체를 고르면 다른 뜻이다.
  const [scope, selectionRead] = await Promise.all([currentDrawingScope(), readSelection()]);
  const selection = selectionRead.outline;
  // 작업 기록용: 선택한 개수, 또는 선택을 못 읽은 이유.
  const selected = selectionRead.error ? { error: selectionRead.error } : { count: selectionRead.count };

  // 도면 이름은 보내지 않을 낱말로 기억하고, 추적 값은 뒤에서 다시 읽는다.
  void addTerms([scope.label]);
  void checkTracked(scope).catch(error => process.stderr.write(`MyCivil3DMcp tracking check failed: ${String(error)}\n`));

  // 앞 대화도 키에 들어간다: 이어지는 질문은 같은 대화 뒤에서만 재사용된다.
  const knowledgeFacts = await readKnowledge(scope);
  const earlier = historyPrompt(conversation);
  const key = hashKey(
    normalizeQuestion(question),
    await paletteVersion(provider),
    JSON.stringify(knowledgeFacts),
    ...(earlier ? [earlier] : []),
    ...(selection ? [selection] : [])
  );

  const cached = await findAnswer("chat", provider, key, scope);
  if (cached) {
    remember(conversation, { provider, question, answer: cached.answer });
    void compactConversation(conversation, provider);
    await log({ kind: "chat", drawing: scope.label, selected, cached: true, answer: clip(cached.answer) });
    syncSoon();
    return {
      provider, requestId, answer: cached.answer, usage: NO_USAGE, totals: getUsageTotals(provider),
      cached: true, cachedAt: new Date(cached.createdAt).toISOString(), savedUsage: cached.usage, recorded: [],
      conversation: status(conversation)
    };
  }

  // ── 3) 프롬프트 (AI가 읽는 문장은 영어로 둔다)
  const [knowledge, outline] = await Promise.all([Promise.resolve(knowledgePrompt(knowledgeFacts)), drawingOutline()]);
  const prompt = [
    ...(outline ? [outline, ""] : []),
    ...(selection ? [selection, ""] : []),
    ...(knowledge ? [`Drawing knowledge for ${scope.label}:`, knowledge, ""] : []),
    ...(earlier ? [earlier, ""] : []),
    "Question:",
    question
  ].join("\n");

  // AI 실행. 도구 호출은 진행 문구로, 답 글자는 혼잣말·<facts>를 걸러 팔레트에 보낸다.
  const filter = new FactsFilter();
  const tools: string[] = [];
  onProgress?.({ type: "progress", text: "생각하는 중" });
  let result: Awaited<ReturnType<typeof askProvider>>;
  try {
    result = await askProvider(provider, prompt, {
      tools: true,
      requestId, signal, drawingId: scope.drawingId,
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
    await log({ kind: "chat", drawing: scope.label, selected, tools, error: clip(error instanceof Error ? error.message : String(error), 1000) });
    syncSoon();
    await settleOperations(requestId);
    throw Object.assign(error instanceof Error ? error : new Error(String(error)), { applied: await appliedFor(requestId) });
  }

  // ── 4) 답 정리와 지식 저장
  const totals = addUsage(provider, result.usage);
  const split = splitFacts(result.answer);
  const answer = dropSelfNotes(split.answer);
  const proposals = split.proposals;
  const general = proposals.filter(proposal => proposal.scope === "general");
  const [recorded, candidates] = await Promise.all([
    appendFacts(scope, proposals.filter(proposal => proposal.scope !== "general"), provider),
    addCandidates(general, scope.label, provider)
  ]);

  // 이 요청에서 적용한 도면 변경과 계산한 수정안.
  // 수정안 id는 보이는 답에서는 빼지만 대화에는 함께 남겨, 사용자가 다음에 그중 하나에 동의할 수 있게 한다.
  // 도면을 바꾸었거나 수정안을 낸 답은 재사용하지 않는다(다시 보여 줘도 적용되지 않고 id도 없다).
  const [applied, fixes] = await Promise.all([appliedFor(requestId), fixesFor(requestId)]);
  const after = await currentDrawingScope();
  if (!applied.length && !fixes.length && after.drawingId === scope.drawingId && after.state === scope.state) {
    await saveAnswer({ kind: "chat", provider, key, question, scope: scope.key, state: scope.state, drawingId: scope.drawingId, answer, usage: result.usage });
  }

  // ── 5) 대화에 남기고, 요약·기록·동기화
  const fixNote = fixes.length
    ? "\n[이 답의 수정안 id] " + fixes.map(fix => `${fix.id}: ${fix.target} · ${fix.title}${fix.applicable ? "" : " (자동 적용 불가)"}`).join("; ")
    : "";
  const appliedNote = applied.length
    ? "\n[도면 변경 결과] " + applied.map(entry => `${entry.state === "applied" ? "적용됨" : "결과 확인 필요"}: ${entry.labels.join(", ")}`).join("; ")
    : "";
  remember(conversation, { provider, question, answer: answer + appliedNote + fixNote, fixIds: fixes.map(fix => fix.id) });
  void compactConversation(conversation, provider);

  await log({
    kind: "chat", drawing: scope.label, selected, model: await paletteModel(provider), tools, answer: clip(answer),
    applied: applied.map(entry => entry.labels.join(", ")), fixes: fixes.map(fix => fix.id), recorded, candidates, usage: result.usage
  });
  syncSoon();

  return {
    provider, requestId, answer, usage: result.usage, totals, cached: false, recorded, candidates, conversation: status(conversation),
    fixes: fixes.map(fixCard),
    applied: applied.map(entry => ({ operationId: entry.operationId, fixId: entry.fixId, state: entry.state, recheck: entry.recheck, warnings: entry.warnings, title: entry.title, target: entry.target, labels: entry.labels, kind: entry.kind }))
  };
}

// /compact : 지금 바로 앞 대화를 요약한다.
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
