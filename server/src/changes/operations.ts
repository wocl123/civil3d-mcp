import { fixLabels } from "./describe.js";
import { callPlugin } from "../bridge/pluginClient.js";
import { withFileLock } from "../files.js";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { dataDir } from "../paths.js";
import { writeAtomic } from "../files.js";
import type { StoredFix } from "./types/StoredFix.js";

export type Operation = {
  operationId: string; fixId: string; requestId: string; at: string;
  state: "running" | "applied" | "rejected" | "unknown" | "undone" | "confirmed";   // confirmed: 사용자가 [확정]을 누름
  title: string; target: string; labels: string[]; kind?: "delete" | "create" | "change";
  drawingId: string; revision: string; result?: Record<string, unknown>; recheck?: unknown; warnings?: string[];
};
export const operationFile = (id: string) => join(dataDir(), "changes", "operations", `${id}.json`);
export const usageFile = (id: string) => join(dataDir(), "changes", "used", `${id}.json`);
export async function readOperation(id: string): Promise<Operation> {
  if (!/^[a-f\d-]{36}$/i.test(id)) throw new Error("Invalid operation id.");
  return JSON.parse(await readFile(operationFile(id), "utf8")) as Operation;
}
export async function saveOperation(operation: Operation): Promise<void> {
  await writeAtomic(operationFile(operation.operationId), JSON.stringify(operation));
  await writeAtomic(usageFile(operation.fixId), JSON.stringify(operation));
}
export async function usedFix(id: string): Promise<Operation | undefined> {
  try { return JSON.parse(await readFile(usageFile(id), "utf8")) as Operation; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
export async function operationsFor(requestId: string): Promise<Operation[]> {
  const folder = join(dataDir(), "changes", "operations");
  const entries = await Promise.all((await readdir(folder).catch(() => [] as string[]))
    .filter(name => name.endsWith(".json")).map(name => readOperation(name.slice(0, -5))));
  return entries.filter(item => item.requestId === requestId && ["applied", "unknown", "running"].includes(item.state))
    .map(item => item.state === "running" ? { ...item, state: "unknown" as const } : item);
}
// 사용자가 [취소]를 누른 계획. 그 뒤에는 AI도 버튼도 적용하지 못한다.
const cancelFile = (id: string) => join(dataDir(), "changes", "cancelled", `${id}.json`);
export async function cancelFix(fixId: string, offered: string[]): Promise<void> {
  if (!offered.includes(fixId)) throw new Error("This fix does not belong to this conversation.");
  await withFileLock(usageFile(fixId), async () => {
    const used = await usedFix(fixId);
    if (used && used.state !== "rejected") throw new Error("이미 적용한 계획은 취소할 수 없습니다. 되돌리기를 눌러 주세요.");
    await writeAtomic(cancelFile(fixId), JSON.stringify({ fixId, at: new Date().toISOString() }));
  });
}
export async function cancelledFix(fixId: string): Promise<boolean> {
  return readFile(cancelFile(fixId), "utf8").then(() => true, () => false);
}

// kind: 팔레트 카드의 버튼 이름을 고른다(delete → [진행]/[취소]).
export const fixCard = (fix: StoredFix) => ({ fixId: fix.id, title: fix.title, target: fix.target,
  kind: fix.remove ? "delete" : fix.create ? "create" : "change",
  labels: fixLabels(fix),
  applicable: fix.applicable && !!fix.binding, reason: fix.reason });

// CLI 종료는 CAD의 커밋을 되돌리지 않는다. 미확인 요청은 취소 표식을 보내거나 영수증을 읽어 정리한다.
export async function settleOperations(requestId: string): Promise<void> {
  for (const entry of await operationsFor(requestId)) {
    if (entry.state === "applied") continue;
    await withFileLock(usageFile(entry.fixId), async () => {
      const operation = await readOperation(entry.operationId);
      try {
        const receipt = await callPlugin(operation.state === "running" ? "change.cancel" : "change.result",
          { operationId: operation.operationId, drawingId: operation.drawingId }) as Record<string, unknown>;
        operation.state = receipt.state === "applied" ? "applied"
          : ["cancelled", "rejected"].includes(String(receipt.state)) ? "rejected" : "unknown";
        operation.revision = String(receipt.revision);
        operation.result = receipt;
        if (operation.state === "applied") operation.recheck = { state: "failed", error: "AI 요청이 종료되어 재검토하지 못했습니다." };
      } catch { operation.state = "unknown"; }
      await saveOperation(operation);
    }).catch(error => process.stderr.write(`Operation reconciliation failed: ${String(error)}\n`));
  }
}

// 버튼 응답을 잃었을 때 사용 기록과 C# 영수증으로 상태를 복구한다. 변경을 재실행하지 않는다.
export async function operationStatus(fixId: string, offered: string[]): Promise<Operation> {
  if (!offered.includes(fixId)) throw new Error("This fix does not belong to this conversation.");
  return withFileLock(usageFile(fixId), async () => {
    const operation = await usedFix(fixId);
    if (!operation) throw new Error("This fix has no operation receipt.");
    const receipt = await callPlugin("change.result", { operationId: operation.operationId }) as Record<string, unknown>;
    operation.state = ["applied", "undone", "rejected"].includes(String(receipt.state)) ? receipt.state as Operation["state"] : "unknown";
    operation.revision = String(receipt.revision);
    operation.result = receipt;
    await saveOperation(operation);
    return operation;
  });
}
