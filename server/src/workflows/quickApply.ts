import { applyFix } from "../changes/applyChange.js";
import { appliedFor, fixesFor, loadFix } from "../changes/changeStore.js";
import { cancelledFix, usedFix } from "../changes/operations.js";
import { offeredFixes } from "./conversation.js";

// 바로 앞 답의 단일 수정안에 대한 명시적 동의만 처리한다. 다른 문장은 AI에게 전달한다.
export async function quickApply(question: string, conversation: string | undefined, requestId: string,
  progress?: () => void, signal?: AbortSignal) {
  if (!/^(진행|진행해|진행해줘|진행해주세요|적용|적용해|적용해줘|적용해주세요|실행해줘|실행해주세요|고고|ㄱㄱ)[.!~\s]*$/u.test(question)) {
    return undefined;
  }

  const offered = [...new Set(offeredFixes(conversation, 1))];
  if (offered.length !== 1) {
    return undefined;
  }

  const fixId = offered[0];
  if (await cancelledFix(fixId) || await usedFix(fixId)) {
    return undefined;
  }

  const fix = await loadFix(fixId);
  if (!fix.applicable) {
    return undefined;
  }

  progress?.();
  signal?.throwIfAborted();
  // 버튼과 같은 검증/커밋/재검토 경로. 실패했을 때 AI로 재시도하지 않는다.
  await applyFix(fixId, offered, requestId);
  const [applied, fixes] = await Promise.all([appliedFor(requestId), fixesFor(requestId)]);
  const answer = applied.map(entry => `${entry.labels.join(", ")}: ` +
    (entry.state === "applied" ? "적용했습니다." : "도면에서 결과 확인이 필요합니다.")).join("\n");
  return { answer, applied, fixes, fixId };
}
