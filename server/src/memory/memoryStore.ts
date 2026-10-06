import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeAtomic } from "../files.js";
import { dataDir } from "../paths.js";
import type { CachedAnswer } from "./types/CachedAnswer.js";
import type { DrawingScope } from "./types/DrawingScope.js";
import type { PaletteMemory } from "./types/PaletteMemory.js";

const ANSWER_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ANSWERS = 300;

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
      ? { version: 1, answers: parsed.answers } : { version: 1, answers: [] };
  } catch {
    memory = { version: 1, answers: [] };
  }
  return memory;
}

// Writes are queued so concurrent requests cannot interleave partial files.
function persist(data: PaletteMemory): Promise<void> {
  const file = memoryFile();
  const text = JSON.stringify(data);
  writing = writing.then(() => writeAtomic(file, text)).catch(error => {
    process.stderr.write(`MyCivil3DMcp memory was not saved: ${String(error)}\n`);
  });
  return writing;
}

// Spacing, case, and punctuation do not change the meaning of a question,
// so "레이어 몇 개야?" and "레이어 몇개야" share one cache entry.
export function normalizeQuestion(text: string): string {
  return text.normalize("NFKC").toLocaleLowerCase("ko-KR").replace(/[\s\p{P}\p{S}]+/gu, "");
}

export function hashKey(...parts: string[]): string {
  return createHash("sha256").update(parts.join("\u0000")).digest("hex");
}

// An answer is reused only for the same AI, the same question, and the same drawing state,
// because each AI may answer differently and drawing edits can make an answer stale.
export async function findAnswer(kind: CachedAnswer["kind"], provider: CachedAnswer["provider"],
  key: string, scope: DrawingScope): Promise<CachedAnswer | undefined> {
  const data = await load();
  const now = Date.now();
  const found = data.answers.find(answer => answer.kind === kind && answer.provider === provider &&
    answer.key === key && answer.scope === scope.key && answer.state === scope.state &&
    now - answer.createdAt < ANSWER_TTL_MS);
  if (found) {
    found.hits++;
    found.lastUsedAt = now;
    await persist(data);
  }
  return found;
}

export async function saveAnswer(entry: Omit<CachedAnswer, "createdAt" | "lastUsedAt" | "hits">): Promise<void> {
  const data = await load();
  const now = Date.now();
  data.answers = [
    { ...entry, createdAt: now, lastUsedAt: now, hits: 0 },
    ...data.answers.filter(answer => now - answer.createdAt < ANSWER_TTL_MS && !(
      answer.kind === entry.kind && answer.provider === entry.provider &&
      answer.key === entry.key && answer.scope === entry.scope))
  ].sort((a, b) => b.lastUsedAt - a.lastUsedAt).slice(0, MAX_ANSWERS);
  await persist(data);
}

export async function clearMemory(): Promise<void> {
  memory = { version: 1, answers: [] };
  await persist(memory);
}
