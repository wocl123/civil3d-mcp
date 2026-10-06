import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { knowledgeDir } from "./knowledgeStore.js";
import type { KnowledgeRule } from "./types/KnowledgeRule.js";

// Common rules apply to every drawing. People write them; the AI only reads them.
// Rules marked "always" go into every request, so keep them short. The others are
// listed by description and read through the read_knowledge_rule tool when needed.
const defaultsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "knowledge-defaults", "rules");
const MAX_ALWAYS_CHARS = 4000;
const MAX_RULE_CHARS = 20000;

export function rulesDir(): string {
  return join(knowledgeDir(), "rules");
}

// Each shipped rule is installed once, and .installed records the content installed
// ("name<TAB>sha256"). A copy nobody has changed since is replaced when a later version
// ships a new text; a copy people edited, or a rule they deleted, is left as it is.
// Older records without a hash are kept as they are until the copy equals the shipped text.
let ensured = false;
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

async function ensureDefaultRules(): Promise<void> {
  if (ensured) return;
  ensured = true;
  try {
    await mkdir(rulesDir(), { recursive: true });
    const record = join(rulesDir(), ".installed");
    const installed = new Map<string, string | undefined>((await readFile(record, "utf8").catch(() => "")).split(/\r?\n/).filter(Boolean)
      .map((line): [string, string | undefined] => { const [name, hash] = line.split("\t"); return [name, hash]; }));
    const present = new Set(await readdir(rulesDir()));
    let changed = false;
    for (const name of await readdir(defaultsDir)) {
      if (!name.endsWith(".md")) continue;
      const shipped = await readFile(join(defaultsDir, name), "utf8");
      const target = join(rulesDir(), name);
      if (!installed.has(name)) {
        if (!present.has(name)) await writeFile(target, shipped, "utf8");
        installed.set(name, present.has(name) ? undefined : sha(shipped));
        changed = true;
        continue;
      }
      if (!present.has(name)) continue;
      const current = sha(await readFile(target, "utf8"));
      const recorded = installed.get(name);
      if (current === sha(shipped)) {
        if (recorded !== current) { installed.set(name, current); changed = true; }
      } else if (recorded && current === recorded) {
        await writeFile(target, shipped, "utf8");
        installed.set(name, sha(shipped));
        changed = true;
      }
    }
    if (changed) await writeFile(record, [...installed].map(([name, hash]) => hash ? `${name}\t${hash}` : name).join("\n") + "\n", "utf8");
  } catch (error) {
    process.stderr.write(`MyCivil3DMcp default rules were not installed: ${String(error)}\n`);
  }
}

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
  } catch { return []; }
}

// Only names from the listing are accepted, so a request cannot read other files.
export async function readRule(name: string): Promise<KnowledgeRule | undefined> {
  const rule = (await listRules()).find(item => item.name === name.replace(/\.md$/i, ""));
  return rule && { ...rule, body: rule.body.slice(0, MAX_RULE_CHARS) };
}

export async function rulesPrompt(): Promise<string> {
  const rules = await listRules();
  const always = rules.filter(rule => rule.always).map(rule => rule.body).join("\n\n").slice(0, MAX_ALWAYS_CHARS);
  const others = rules.filter(rule => !rule.always);
  return [
    always,
    ...(others.length ? ["", "Other rule files. Read one with read_knowledge_rule when its description fits the question:",
      ...others.map(rule => `- ${rule.name}: ${rule.description}`)] : [])
  ].join("\n").trim();
}
