import { withFileLock } from "../files.js";
// 공통 규칙 (data/knowledge/rules/*.md).
// 모든 도면에 적용된다. 사람이 쓰고 AI는 읽기만 한다.
//   - always: true 인 규칙은 매 요청에 들어가므로 짧게 둔다.
//   - 나머지는 설명만 목록으로 주고, 필요할 때 AI가 read_knowledge_rule 로 읽는다.

import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { knowledgeDir } from "./knowledgeStore.js";
import type { KnowledgeRule } from "./types/KnowledgeRule.js";

// 서버와 함께 배포되는 기본 규칙 폴더.
const defaultsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "knowledge-defaults", "rules");

const MAX_ALWAYS_CHARS = 4000;   // 매 요청에 들어가는 규칙의 글자 수 한도
const MAX_RULE_CHARS = 20000;    // 규칙 하나를 읽을 때의 한도

export function rulesDir(): string {
  return join(knowledgeDir(), "rules");
}

// 기본 규칙 설치.
// 배포된 규칙마다 한 번 설치하고, .installed 에 설치한 내용의 해시를 적는다("이름<TAB>sha256").
//   - 아무도 고치지 않은 사본은, 새 버전이 다른 내용을 배포하면 새 내용으로 바꾼다.
//   - 사람이 고친 사본이나 지운 규칙은 그대로 둔다.
//   - 해시 없는 옛 기록은 사본이 배포본과 같아질 때까지 그대로 둔다.
let ensuring: Promise<void> | undefined;
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

function ensureDefaultRules(): Promise<void> {
  // 여러 MCP 프로세스의 초기 설치가 .installed 및 규칙 파일을 동시에 덮어쓰지 않게 한다.
  return ensuring ??= withFileLock(join(rulesDir(), ".installed"), installDefaultRules);
}

async function installDefaultRules(): Promise<void> {
  try {
    await mkdir(rulesDir(), { recursive: true });

    // 설치 기록 읽기: 이름 → 설치한 내용의 해시(없으면 undefined)
    const record = join(rulesDir(), ".installed");
    const recordText = await readFile(record, "utf8").catch(() => "");
    const installed = new Map<string, string | undefined>(recordText.split(/\r?\n/).filter(Boolean)
      .map((line): [string, string | undefined] => {
        const [name, hash] = line.split("\t");
        return [name, hash];
      }));

    const present = new Set(await readdir(rulesDir()));
    let changed = false;

    for (const name of await readdir(defaultsDir)) {
      if (!name.endsWith(".md")) continue;
      const shipped = await readFile(join(defaultsDir, name), "utf8");
      const target = join(rulesDir(), name);

      // 처음 보는 규칙: 없으면 설치. 사람이 먼저 만들어 둔 같은 이름 파일은 건드리지 않는다.
      if (!installed.has(name)) {
        if (!present.has(name)) await writeFile(target, shipped, "utf8");
        installed.set(name, present.has(name) ? undefined : sha(shipped));
        changed = true;
        continue;
      }

      // 사람이 지운 규칙은 다시 설치하지 않는다.
      if (!present.has(name)) continue;

      const current = sha(await readFile(target, "utf8"));
      const recorded = installed.get(name);
      if (current === sha(shipped)) {
        // 이미 배포본과 같다: 기록만 맞춘다.
        if (recorded !== current) { installed.set(name, current); changed = true; }
      } else if (recorded && current === recorded) {
        // 설치한 뒤 아무도 안 고쳤고 배포본이 바뀌었다: 새 내용으로.
        await writeFile(target, shipped, "utf8");
        installed.set(name, sha(shipped));
        changed = true;
      }
    }

    if (changed) {
      const lines = [...installed].map(([name, hash]) => hash ? `${name}\t${hash}` : name);
      await writeFile(record, lines.join("\n") + "\n", "utf8");
    }
  } catch (error) {
    process.stderr.write(`MyCivil3DMcp default rules were not installed: ${String(error)}\n`);
  }
}

// 규칙 파일 하나: 맨 위 --- 머리말 --- 의 description, always 와 본문.
function parseRule(name: string, text: string): KnowledgeRule {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  const header = match?.[1] ?? "";
  const value = (key: string) => new RegExp(`^${key}:\\s*(.*)$`, "m").exec(header)?.[1].trim();
  return {
    name: name.replace(/\.md$/i, ""),
    description: value("description") ?? "",
    always: value("always") === "true",
    body: text.slice(match?.[0].length ?? 0).trim()
  };
}

export async function listRules(): Promise<KnowledgeRule[]> {
  await ensureDefaultRules();
  try {
    const names = (await readdir(rulesDir())).filter(name => name.endsWith(".md")).sort();
    return await Promise.all(names.map(async name => parseRule(name, await readFile(join(rulesDir(), name), "utf8"))));
  } catch {
    return [];
  }
}

// 목록에 있는 이름만 받는다(요청이 다른 파일을 읽지 못하게).
export async function readRule(name: string): Promise<KnowledgeRule | undefined> {
  const rule = (await listRules()).find(item => item.name === name.replace(/\.md$/i, ""));
  return rule && { ...rule, body: rule.body.slice(0, MAX_RULE_CHARS) };
}

// 지시문에 들어가는 공통 규칙: always 규칙 본문 + 나머지 규칙의 이름·설명 목록.
// (목록 안내 문장은 AI가 읽으므로 영어로 둔다.)
export async function rulesPrompt(): Promise<string> {
  const rules = await listRules();
  const always = rules.filter(rule => rule.always).map(rule => rule.body).join("\n\n").slice(0, MAX_ALWAYS_CHARS);
  const others = rules.filter(rule => !rule.always);
  const list = others.length
    ? ["", "Other rule files. Read one with read_knowledge_rule when its description fits the question:",
      ...others.map(rule => `- ${rule.name}: ${rule.description}`)]
    : [];
  return [always, ...list].join("\n").trim();
}
