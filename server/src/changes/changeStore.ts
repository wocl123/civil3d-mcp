import { currentRequestId } from "./requestContext.js";
import { operationsFor } from "./operations.js";
// 수정안 저장소.
// 검토 도구가 계산한 수정안을 id를 붙여 data/changes/fixes 에 저장한다.
//   - AI는 값을 다시 말하지 않고 id로 수정안을 가리킨다.
//   - 적용한 뒤 그 수정안을 만든 검토를 다시 돌릴 수 있다.
// 적용 시도는 모두 data/logs/<날짜>/changes.jsonl 에 남긴다.
// MCP 서버(검토·적용)와 팔레트 서비스가 이 파일들을 함께 쓴다.

import { drawingContext } from "../bridge/drawingContext.js";
import { currentDrawingScope } from "../memory/drawingScope.js";
import { contentVersion } from "../knowledge/contentVersion.js";
import { writeAtomic } from "../files.js";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { dataDir } from "../paths.js";
import type { CheckItem } from "../criteria/types/CheckItem.js";
import type { FixOption } from "../criteria/types/FixOption.js";
import type { StoredFix, FixSource } from "./types/StoredFix.js";
import type { ChangeLogEntry } from "./types/ChangeLogEntry.js";
import { supported } from "./describe.js";
import { logChangeEntry } from "../logs/workLog.js";

// 수정안 보관 기간: 2일.
const KEEP_MS = 2 * 24 * 60 * 60 * 1000;

const dir = (...parts: string[]) => join(dataDir(), "changes", ...parts);

// 이 수정안을 계산한 팔레트 요청(서비스가 MCP 서버에 환경 변수로 넘긴다).
const requestId = currentRequestId;

// 보관 기간이 지난 파일을 지운다.
async function removeOld(folder: string): Promise<void> {
  const now = Date.now();
  for (const name of await readdir(folder).catch(() => [] as string[])) {
    if (!/^fx-[a-f\d]{10}\.json$/.test(name)) continue;
    const path = join(folder, name);
    const info = await stat(path).catch(() => undefined);
    if (info && now - info.mtimeMs > KEEP_MS) await rm(path, { force: true });
  }
}

// 검토 결과의 모든 수정안에 id를 붙이고, 그 수정안을 만든 검토와 함께 저장한다.
export async function registerFixes(items: CheckItem[], source: FixSource): Promise<void> {
  for (const item of items)
    for (const fix of item.fixes ?? []) await storeFix(fix, item.target, `${item.article} ${item.check}`, source, item.targetRef);
}

// 수정안(또는 선형 생성 계획) 하나를 저장하고, id와 자동 적용 가능 여부를 채운다.
export async function storeFix(fix: FixOption, target: string, check: string, source: FixSource, targetRef?: StoredFix["targetRef"]): Promise<void> {
  const scope = await currentDrawingScope();
  const context = drawingContext() ?? (scope.drawingId ? { drawingId: scope.drawingId, revision: scope.state } : undefined);
  const version = context?.criteriaVersion ?? await contentVersion();
  await removeOld(dir("fixes"));
  await mkdir(dir("fixes"), { recursive: true });

  // id에 요청을 넣는다: 같은 수정안을 나중 답변에서 다시 계산해도 새 id가 생겨,
  // 한 답변에서 보여 준 id를 다른 답변이 가로채지 않는다.
  const hash = createHash("sha256").update(requestId() + JSON.stringify(context) + version + JSON.stringify(fix.create ?? fix.remove ?? fix.edit ?? fix.changes)).digest("hex");
  fix.id = "fx-" + hash.slice(0, 10);

  // 자동 적용 가능: conflict가 아니고, 생성·삭제·속성 편집 계획이거나 모든 변경을 플러그인이 지원할 때.
  fix.applicable = !!context && fix.status !== "conflict" &&
    (fix.create !== undefined || fix.remove !== undefined || fix.edit !== undefined || (fix.changes.length > 0 && fix.changes.every(supported)));

  const stored: StoredFix = {
    ...fix,
    id: fix.id,
    applicable: fix.applicable,
    target,
    check,
    createdAt: new Date().toISOString(),
    requestId: requestId(),
    source, targetRef,
    ...(context ? { binding: { ...context, criteriaVersion: version, expiresAt: new Date(Date.now() + KEEP_MS).toISOString() } } : {})
  };
  await writeAtomic(dir("fixes", `${fix.id}.json`), JSON.stringify(stored, null, 1));
}

// id로 수정안을 읽는다. 없거나 기간이 지났으면 다시 검토하라고 알린다.
export async function loadFix(id: string): Promise<StoredFix> {
  if (!/^fx-[a-f\d]{10}$/.test(id)) throw new Error(`Unknown fix id "${id}".`);
  const text = await readFile(dir("fixes", `${id}.json`), "utf8").catch(() => undefined);
  if (!text) throw new Error(`Fix ${id} was not found or has expired. Run the check again.`);
  const fix = JSON.parse(text) as StoredFix;
  if (Date.now() - Date.parse(fix.createdAt) >= KEEP_MS) throw new Error(`Fix ${id} has expired. Run the check again.`);
  return fix;
}

// 한 팔레트 요청에서 계산된 수정안들.
// 이 id들이 대화에 남고, 다음 질문들에서는 이 id만 적용할 수 있다.
export async function fixesFor(id: string): Promise<StoredFix[]> {
  const found: StoredFix[] = [];
  for (const name of await readdir(dir("fixes")).catch(() => [] as string[])) {
    if (!/^fx-[a-f\d]{10}\.json$/.test(name)) continue;
    const text = await readFile(dir("fixes", name), "utf8").catch(() => undefined);
    if (!text) continue;
    const fix = JSON.parse(text) as StoredFix;
    if (fix.requestId === id) found.push(fix);
  }
  return found.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

// 적용 시도 하나를 기록한다.
export async function logChange(entry: Omit<ChangeLogEntry, "at" | "requestId"> & { requestId?: string }): Promise<void> {
  await logChangeEntry({ requestId: requestId(), ...entry });
}

// 한 팔레트 요청에서 실제로 적용된 변경들(답변 아래 "도면 수정 적용됨" 표시용).
export async function appliedFor(id: string) {
  // 작업 영수증은 도면 변경 결과의 원본이다. 로그 실패 때문에 버튼이 사라지지 않게 한다.
  return operationsFor(id);
}
