// 답변 재사용 저장소 (data/memory/answers.json).
// 같은 AI에게 같은 질문을, 도면이 바뀌지 않은 상태에서 다시 하면 AI를 부르지 않고 저장한 답을 쓴다.

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeAtomic } from "../files.js";
import { dataDir } from "../paths.js";
import type { CachedAnswer } from "./types/CachedAnswer.js";
import type { DrawingScope } from "./types/DrawingScope.js";
import type { PaletteMemory } from "./types/PaletteMemory.js";

const ANSWER_TTL_MS = 7 * 24 * 60 * 60 * 1000;   // 답변 보관 기간: 7일
const MAX_ANSWERS = 300;                         // 최대 개수(오래 안 쓴 것부터 버림)

// 메모리에 올려 둔 파일 내용과, 쓰기 줄.
let memory: PaletteMemory | undefined;
let loading: Promise<PaletteMemory> | undefined;
let writing: Promise<void> = Promise.resolve();

function memoryFile(): string {
  if (process.env.MY_CIVIL3D_MEMORY_FILE) return process.env.MY_CIVIL3D_MEMORY_FILE;
  return join(dataDir(), "memory", "answers.json");
}

function load(): Promise<PaletteMemory> {
  if (memory) return Promise.resolve(memory);
  return loading ??= loadOnce().finally(() => { loading = undefined; });
}

async function loadOnce(): Promise<PaletteMemory> {
  if (memory) return memory;
  try {
    const parsed = JSON.parse(await readFile(memoryFile(), "utf8")) as Partial<PaletteMemory>;
    memory = parsed.version === 2 && Array.isArray(parsed.answers)
      ? { version: 2, answers: parsed.answers }
      : { version: 2, answers: [] };
  } catch {
    memory = { version: 2, answers: [] };
  }
  return memory;
}

// 쓰기를 줄 세워, 동시에 온 요청이 반쯤 쓴 파일을 만들지 않게 한다.
function persist(data: PaletteMemory): Promise<void> {
  const file = memoryFile();
  const text = JSON.stringify(data);
  writing = writing.then(() => writeAtomic(file, text)).catch(error => {
    process.stderr.write(`MyCivil3DMcp memory was not saved: ${String(error)}\n`);
  });
  return writing;
}

// 소수점·부호·객체 이름 기호는 의미가 있으므로 보존한다. 공백만 정리한다.
export function normalizeQuestion(text: string): string {
  return text.normalize("NFKC").trim().replace(/\s+/gu, " ");
}

export function hashKey(...parts: string[]): string {
  return createHash("sha256").update(parts.join("\u0000")).digest("hex");
}

// 같은 AI, 같은 질문(키), 같은 도면 상태일 때만 다시 쓴다.
// AI마다 답이 다를 수 있고, 도면을 고치면 답이 낡기 때문이다.
export async function findAnswer(kind: CachedAnswer["kind"], provider: CachedAnswer["provider"],
  key: string, scope: DrawingScope): Promise<CachedAnswer | undefined> {
  if (!scope.drawingId || scope.state === "legacy") return undefined;
  const data = await load();
  const now = Date.now();
  const found = data.answers.find(answer =>
    answer.kind === kind && answer.provider === provider && answer.key === key &&
    answer.scope === scope.key && answer.state === scope.state && answer.drawingId === scope.drawingId &&
    now - answer.createdAt < ANSWER_TTL_MS);

  if (found) {
    found.hits++;
    found.lastUsedAt = now;
    await persist(data);
  }
  return found;
}

// 답을 저장한다. 같은 AI·질문·도면의 옛 답과 기간이 지난 답은 지우고, 최근 사용 순으로 300개까지.
export async function saveAnswer(entry: Omit<CachedAnswer, "createdAt" | "lastUsedAt" | "hits">): Promise<void> {
  if (!entry.drawingId || entry.state === "legacy") return;
  const data = await load();
  const now = Date.now();
  const others = data.answers.filter(answer =>
    now - answer.createdAt < ANSWER_TTL_MS &&
    !(answer.kind === entry.kind && answer.provider === entry.provider && answer.key === entry.key && answer.scope === entry.scope));

  data.answers = [{ ...entry, createdAt: now, lastUsedAt: now, hits: 0 }, ...others]
    .sort((a, b) => b.lastUsedAt - a.lastUsedAt)
    .slice(0, MAX_ANSWERS);
  await persist(data);
}

export async function clearMemory(): Promise<void> {
  memory = { version: 2, answers: [] };
  await persist(memory);
}
