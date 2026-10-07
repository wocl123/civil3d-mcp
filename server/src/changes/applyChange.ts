import { inChangeRequest } from "./requestContext.js";
// 변경의 커밋과 재검토는 서로 다른 결과다. 커밋 뒤의 오류가 "변경 없음"으로 전달되어서는 안 된다.
import { randomUUID } from "node:crypto";
import { callPlugin } from "../bridge/pluginClient.js";
import { inDrawingContext } from "../bridge/drawingContext.js";
import { currentDrawingScope } from "../memory/drawingScope.js";
import { contentVersion } from "../knowledge/contentVersion.js";
import { withFileLock } from "../files.js";
import { checkAlignmentCriteria } from "../criteria/alignmentCriteria.js";
import { checkProfileCriteria } from "../criteria/profileCriteria.js";
import { assess, fullItems } from "../criteria/reportBuilder.js";
import { loadFix, logChange, registerFixes } from "./changeStore.js";
import { fixLabels } from "./describe.js";
import { failureGuide } from "../errors/failureGuide.js";
import type { ChangeLogEntry } from "./types/ChangeLogEntry.js";
import type { StoredFix } from "./types/StoredFix.js";
import { trackApplied } from "../tracking/trackApplied.js";
import { cancelledFix, readOperation, saveOperation, usedFix, usageFile, type Operation } from "./operations.js";

const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error);

export async function applyFix(fixId: string, offered: string[], requestId = process.env.MY_CIVIL3D_REQUEST_ID ?? "none",
  reapplyOperation?: string) {
  if (!offered.includes(fixId)) throw new Error(`Fix ${fixId} was not offered to the user in this conversation. Show it and ask before applying.`);
  return inChangeRequest(requestId, () => withFileLock(usageFile(fixId), async () => {
    const fix = await loadFix(fixId);
    if (!fix.binding) throw new Error("The stored fix has no drawing identity. Run the check again.");
    if (!fix.applicable) throw new Error(fix.status === "conflict"
      ? `Fix ${fixId} cannot be applied: ${fix.reason ?? "it conflicts with neighbouring elements"}.`
      : `Fix ${fixId} has changes the plug-in cannot apply; the user must change the drawing by hand.`);
    if (await cancelledFix(fixId)) throw new Error(`Fix ${fixId} was cancelled by the user. Plan again if the user still wants it.`);
    if (Date.parse(fix.binding.expiresAt) <= Date.now()) throw new Error(`Fix ${fixId} has expired. Run the check again.`);
    if (fix.binding.criteriaVersion !== await contentVersion()) throw new Error("Criteria changed since the fix was calculated. Run the check again.");
    const previous = await usedFix(fixId);
    let expectedRevision = fix.binding.revision;
    if (previous && previous.state !== "rejected") {
      // 되돌리기 확인 영수증이 있을 때만 재적용을 허용한다. 아무 변경 뒤에 수정안을 재활용하지 않는다.
      if (previous.state !== "undone" || previous.operationId !== reapplyOperation)
        throw new Error("Fix already applied or its outcome is unknown. Check the operation before continuing.");
      // 되돌린 삭제는 옛 계획으로 다시 실행하지 않는다. 되돌리기는 "지우지 않겠다"는 결정이고,
      // 다시 지우려면 새 계획(그때의 목록과 영향)을 보고 동의해야 한다.
      if (fix.remove) throw new Error("되돌린 삭제는 다시 실행하지 않습니다. 다시 삭제하려면 새로 요청해 주세요.");
      const receipt = await callPlugin("change.result", { operationId: previous.operationId }) as Operation;
      if (receipt.state !== "undone") throw new Error("Undo result could not be verified.");
      expectedRevision = receipt.revision;
    }
    const scope = await currentDrawingScope();
    if (scope.drawingId !== fix.binding.drawingId) throw new Error("Drawing changed since the fix was calculated.");
    if (scope.state !== expectedRevision) throw new Error("Drawing changed since the fix was calculated. Run the check again.");
    const operation: Operation = { operationId: randomUUID(), fixId, requestId, at: new Date().toISOString(), state: "running",
      title: fix.title, target: fix.target, labels: fixLabels(fix), kind: fix.remove ? "delete" : fix.create ? "create" : "change",
      drawingId: scope.drawingId!, revision: scope.state };
    // 네트워크 요청 전에 실행 사실을 남긴다. 프로세스 종료 후 불명확한 작업을 다시 실행하지 않는다.
    await saveOperation(operation);
    let result: Record<string, unknown>;
    try {
      // 만들기 / 지우기 / 속성 바꾸기 / 값 바꾸기
      const [method, params] = fix.create ? ["alignment.create" as const, fix.create]
        : fix.remove ? ["drawing.delete" as const, { targets: fix.remove.targets }]
        : fix.edit ? ["alignment.edit" as const, { edits: fix.edit.edits }]
        : ["change.apply" as const, { changes: fix.changes.map(item => ({ kind: item.object.kind, handle: item.object.handle,
            at: item.object.at, property: item.property, from: item.from, to: item.to })) }];
      result = await inDrawingContext({ drawingId: scope.drawingId!, revision: scope.state }, () => callPlugin(
        method, { ...params, operationId: operation.operationId })) as Record<string, unknown>;
    } catch (error) {
      const message = messageOf(error);
      const details = error as { drawingChanged?: boolean | "unknown" };
      const guide = { ...failureGuide(message), ...(details.drawingChanged !== undefined ? { drawingChanged: details.drawingChanged } : {}) };
      operation.state = guide.drawingChanged === "unknown" ? "unknown" : "rejected";
      await saveOperation(operation);
      await logChange({ fixId, state: "failed", title: fix.title, target: fix.target, check: fix.check, labels: operation.labels, error: message });
      return { applied: false, mutation: operation.state, operationId: operation.operationId,
        drawingChanged: guide.drawingChanged, fix: fix.title, error: message, guide };
    }
    const revision = String(result.revision);
    operation.state = "applied";
    operation.revision = revision;
    operation.result = result;
    const warnings: string[] = [];
    try { await saveOperation(operation); } catch (error) { warnings.push("적용 기록 저장 실패: " + messageOf(error)); }
    const changeResult = { ...result, ...(fix.create ? { created: result } : {}), revision } as ChangeLogEntry["result"];
    await logChange({ fixId, state: "applied", title: fix.title, target: fix.target, check: fix.check, labels: operation.labels, result: changeResult });
    let recheckResult: Awaited<ReturnType<typeof recheck>> | { state: "failed"; error: string };
    try {
      recheckResult = await inDrawingContext({ drawingId: scope.drawingId!, revision, criteriaVersion: fix.binding!.criteriaVersion }, async () => {
        await trackApplied(fix, changeResult);
        return recheck(fix);
      });
    } catch (error) { recheckResult = { state: "failed", error: messageOf(error) }; }
    operation.recheck = recheckResult;
    operation.warnings = warnings;
    try { await saveOperation(operation); } catch (error) { warnings.push("후속 결과 저장 실패: " + messageOf(error)); }
    // 적용 성공은 재검토·추적·기록 실패와 무관하게 유지한다. 팔레트는 작업 ID로 되돌리기 버튼을 제공한다.
    return { applied: true, mutation: "applied", drawingChanged: true, operationId: operation.operationId,
      fix: fix.title, ...(fix.create ? { created: result } : fix.remove ? { deleted: result.deleted, profiles: result.profiles, profileViews: result.profileViews, corridors: result.corridors }
        : fix.edit ? { edited: result.edited, properties: result.changes } : { changes: result.changes }),
      undo: "팔레트의 되돌리기 버튼으로 취소할 수 있음", warnings, recheck: recheckResult };
  }));
}

async function recheck(fix: StoredFix) {
  if (fix.source.check === "none") return { state: "not_required" as const, assessment: "not_applicable" as const };
  // 여러 종단의 동일 곡선 번호가 섞이지 않게 수정된 객체 핸들로 검토 대상을 한정한다.
  const handle = fix.targetRef?.objectHandle || fix.changes[0]?.object.handle;
  const input = fix.source.input;
  const reports = fix.source.check === "alignment"
    ? [await checkAlignmentCriteria({ ...input, alignment: handle || (input as { alignment: string }).alignment })]
    : await checkProfileCriteria({ ...input, ...(handle ? { profile: handle } : {}) });
  const items = reports.flatMap(fullItems);
  await registerFixes(items, fix.source);
  const key = /^(곡선|경사) (\d+)/.exec(fix.target);
  const sameTarget = fix.create || fix.edit ? items : items.filter(item => fix.targetRef
    ? item.targetRef?.objectHandle === fix.targetRef.objectHandle && item.targetRef.kind === fix.targetRef.kind && item.targetRef.elementKey === fix.targetRef.elementKey
    : !!key && /^(곡선|경사) (\d+)/.exec(item.target)?.[0] === key[0]);
  const assessment = reports.every(report => report.assessment === "not_applicable") ? "not_applicable"
    : assess(sameTarget, reports.some(report => report.missing.length > 0));
  return { state: "completed" as const, assessment, target: fix.target, targetPassed: assessment === "pass",
    targetItems: sameTarget, otherFailures: fix.create || fix.edit ? [] : items.filter(item => item.result === "fail" && !sameTarget.includes(item)),
    summary: reports.map(report => ({ target: report.target, ...report.summary })) };
}

// 확정([확정] 버튼): 사용자가 결과를 받아들였다. 플러그인은 되돌리기용 작업 기록을 버리고,
// 이 작업은 더 이상 버튼으로 되돌리거나 다시 적용할 수 없다.
export async function confirmOperation(operationId: string, offered: string[]) {
  const operation = await readOperation(operationId);
  if (!offered.includes(operation.fixId)) throw new Error("This operation does not belong to this conversation.");
  return withFileLock(usageFile(operation.fixId), async () => {
    const latest = await usedFix(operation.fixId);
    if (latest?.operationId !== operationId) throw new Error("This operation was superseded. Use the latest change card.");
    const current = await readOperation(operationId);
    if (current.state === "confirmed") return { ...current, message: "이미 확정한 변경입니다." };
    if (current.state !== "applied") throw new Error("적용된 상태의 변경만 확정할 수 있습니다.");
    await callPlugin("change.confirm", { operationId });
    current.state = "confirmed";
    // 되돌리기에만 쓰던 결과 상세(지운 객체 목록 등)도 정리한다.
    delete current.result;
    await saveOperation(current);
    return { ...current, message: "변경을 확정했습니다. 되돌리기 기록을 정리했습니다." };
  });
}

export async function undoOperation(operationId: string, offered: string[]) {
  const operation = await readOperation(operationId);
  if (!offered.includes(operation.fixId)) throw new Error("This operation does not belong to this conversation.");
  return withFileLock(usageFile(operation.fixId), async () => {
    // 잠금을 기다리는 동안 재적용되었을 수 있다. 이전 카드가 최신 사용 기록을 덮어쓰지 않게 한다.
    const latest = await usedFix(operation.fixId);
    if (latest?.operationId !== operationId) throw new Error("This operation was superseded. Use the latest change card.");
    const current = await readOperation(operationId);
    // C#이 도면 ID와 마지막 편집 리비전을 검사한다. 현재 활성 도면에 무조건 UNDO를 보내지 않는다.
    let result: Operation & { restored?: number; skippedSteps?: string[]; linkedObjects?: number; commandsAfter?: string[] };
    try {
      result = await callPlugin("change.undo", { operationId }) as typeof result;
    } catch (error) {
      // UNDO가 실행된 뒤 응답을 잃거나 복구 검증이 실패하면 적용 상태로 단정하지 않는다.
      // 도면 전환·후속 편집 등 변경 전 거절(false)은 원래 상태를 유지한다.
      if ((error as { drawingChanged?: boolean | "unknown" }).drawingChanged !== false) {
        current.state = "unknown";
        await saveOperation(current);
      }
      throw error;
    }
    if (result.state !== "undone") {
      current.state = "unknown";
      await saveOperation(current);
      throw new Error("Undo result could not be verified.");
    }
    current.state = result.state;
    current.revision = result.revision;
    await saveOperation(current);
    // 플러그인은 작업 기록(시작~끝)과 작업 뒤 기록(끝~되돌리기)으로 작업 시작 시점까지 거슬러 올라간다.
    // 함께 되돌린 것(화면 확대·이동 등, Civil 3D가 함께 갱신한 연관 객체)을 알리고, 도면 확인을 부탁한다.
    const skipped = result.skippedSteps?.length ?? 0;
    const commands = [...new Set(result.commandsAfter ?? [])].slice(0, 8);
    const message = `작업 전 상태로 되돌렸습니다${result.restored ? ` (삭제했던 객체 ${result.restored}개 복원 확인)` : ""}.` +
      (skipped ? ` 적용 뒤의 화면 변경 등 ${skipped}단계${commands.length ? `(${commands.join(", ")})` : ""}도 함께 되돌렸습니다.` : "") +
      (result.linkedObjects ? ` Civil 3D가 연관 객체 ${result.linkedObjects}개를 함께 갱신했습니다.` : "") +
      " 도면이 작업 전과 같은지 확인해 주세요.";
    return { ...current, message };
  });
}
