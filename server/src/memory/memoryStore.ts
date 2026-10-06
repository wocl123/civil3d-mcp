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
let writing: Promise<void> = Promise.resolve();

function memoryFile(): string {
  if (process.env.MY_CIVIL3D_MEMORY_FILE) return process.env.MY_CIVIL3D_MEMORY_FILE;
  return join(dataDir(), "memory", "answers.json");
}

async function load(): Promise<PaletteMemory> {
  if (memory) return memory;
  try {
    const parsed = JSON.parse(await readFile(memoryFile(), "utf8")) as Partial<PaletteMemory>;
    memory = parsed.version === 1 && Array.isArray(parsed.answers)
      ? { version: 1, answers: parsed.answers }
      : { version: 1, answers: [] };
  } catch {
    memory = { version: 1, answers: [] };
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

// 띄어쓰기·대소문자·문장부호는 뜻을 바꾸지 않으므로 지운다.
// "레이어 몇 개야?"와 "레이어 몇개야"가 같은 답을 쓴다.
export function normalizeQuestion(text: string): string {
  return text.normalize("NFKC").toLocaleLowerCase("ko-KR").replace(/[\s\p{P}\p{S}]+/gu, "");
}

export function hashKey(...parts: string[]): string {
  return createHash("sha256").update(parts.join("\u0000")).digest("hex");
}

// 같은 AI, 같은 질문(키), 같은 도면 상태일 때만 다시 쓴다.
// AI마다 답이 다를 수 있고, 도면을 고치면 답이 낡기 때문이다.
export async function findAnswer(kind: CachedAnswer["kind"], provider: CachedAnswer["provider"],
  key: string, scope: DrawingScope): Promise<CachedAnswer | undefined> {
  const data = await load();
  const now = Date.now();
  const found = data.answers.find(answer =>
    answer.kind === kind && answer.provider === provider && answer.key === key &&
    answer.scope === scope.key && answer.state === scope.state &&
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
  memory = { version: 1, answers: [] };
  await persist(memory);
}
