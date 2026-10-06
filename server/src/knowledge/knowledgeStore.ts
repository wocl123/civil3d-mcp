import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { dataDir } from "../paths.js";
import { hashKey } from "../memory/memoryStore.js";
import type { DrawingScope } from "../memory/types/DrawingScope.js";
import type { FactProposal } from "./types/FactProposal.js";
import type { KnowledgeFact } from "./types/KnowledgeFact.js";

// Knowledge has two layers: rules/ for common rules (rulesStore.ts) and
// drawings/ with one Markdown file per drawing for facts confirmed by the user or read from
// the drawing. People may edit or delete sections; the service only appends new
// sections and marks replaced ones, so earlier decisions stay traceable.
const MAX_PROMPT_FACTS = 30;
const MAX_PROMPT_CHARS = 4000;
const BASIS_LABEL: Record<KnowledgeFact["basis"], string> = { user_answer: "사용자 답변", drawing: "도면 확인" };

let writing: Promise<void> = Promise.resolve();

export function knowledgeDir(): string {
  if (process.env.MY_CIVIL3D_KNOWLEDGE_DIR) return process.env.MY_CIVIL3D_KNOWLEDGE_DIR;
  return join(dataDir(), "knowledge");
}

export function knowledgeFile(scope: DrawingScope): string | undefined {
  if (!scope.key) return undefined;
  const name = (scope.label.replace(/\.dwg$/i, "").replace(/[^\p{L}\p{N}_-]+/gu, "_").slice(0, 60) || "drawing");
  return join(knowledgeDir(), "drawings", `${name}_${hashKey(scope.key).slice(0, 8)}.md`);
}

function oneLine(text: string, max: number): string {
  return text.replace(/\s+/g, " ").trim().slice(0, max);
}

export function parseKnowledge(text: string): KnowledgeFact[] {
  return text.split(/^## /m).slice(1).map((section, index) => {
    const [header = "", ...lines] = section.split(/\r?\n/);
    const field = (name: string) => lines.find(line => line.startsWith(`- ${name}:`))?.slice(name.length + 3).trim();
    const id = /^(F-[\w-]+)/.exec(header)?.[1] ?? `M-${index + 1}`;
    const title = header.replace(/^F-[\w-]+\s*·\s*/, "").trim();
    const body = lines.filter(line => line.trim() && !/^- (근거|기록|상태):/.test(line)).join(" ");
    return {
      id, title,
      content: field("내용") ?? oneLine(body.replace(/^- /, ""), 400),
      basis: field("근거")?.startsWith(BASIS_LABEL.drawing) ? "drawing" : "user_answer",
      evidence: field("근거") ?? "",
      replaced: field("상태")?.startsWith("정정됨") ?? false
    } satisfies KnowledgeFact;
  }).filter(fact => fact.title || fact.content);
}

export async function readKnowledge(scope: DrawingScope): Promise<KnowledgeFact[]> {
  const file = knowledgeFile(scope);
  if (!file) return [];
  try { return parseKnowledge(await readFile(file, "utf8")); }
  catch { return []; }
}

// The prompt block lists current facts newest first, within a fixed size.
export function knowledgePrompt(facts: KnowledgeFact[]): string {
  const lines: string[] = [];
  let size = 0;
  for (const fact of facts.filter(item => !item.replaced).reverse().slice(0, MAX_PROMPT_FACTS)) {
    const line = `- [${fact.id}] ${fact.title}: ${fact.content}`;
    if (size + line.length > MAX_PROMPT_CHARS) break;
    lines.push(line);
    size += line.length;
  }
  return lines.join("\n");
}

// AIs sometimes record a guess despite the skill. Hedged wording marks a guess,
// so such facts are dropped here the same way for every AI.
const HEDGED = /추정|보인다|보임|것\s*같|듯하|아마|가능성|추측|probably|likely|seems|appears/i;

function validProposal(value: unknown): FactProposal | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Record<string, unknown>;
  if (typeof item.title !== "string" || typeof item.content !== "string") return undefined;
  if (item.basis !== "user_answer" && item.basis !== "drawing") return undefined;
  const title = oneLine(item.title, 80);
  const content = oneLine(item.content, 400);
  if (!title || !content || HEDGED.test(content)) return undefined;
  const general = item.scope === "general";
  if (general && item.basis !== "user_answer") return undefined;
  return {
    ...(general ? { scope: "general" as const } : {}),
    title, content, basis: item.basis,
    evidence: typeof item.evidence === "string" ? oneLine(item.evidence, 200) : "",
    replaces: typeof item.replaces === "string" && /^F-[\w-]+$/.test(item.replaces) ? item.replaces : undefined
  };
}

export function readProposals(value: unknown): FactProposal[] {
  return Array.isArray(value) ? value.map(validProposal).filter((item): item is FactProposal => !!item).slice(0, 5) : [];
}

// Appends new facts and marks the ones they replace. Facts identical to a
// current one are skipped so repeated answers do not grow the file.
export async function appendFacts(scope: DrawingScope, proposals: FactProposal[], source: string): Promise<string[]> {
  const file = knowledgeFile(scope);
  if (!file || !proposals.length) return [];
  const added: string[] = [];
  writing = writing.then(async () => {
    let text: string;
    try { text = await readFile(file, "utf8"); }
    catch { text = `# ${scope.label} 지식\n\n이 도면에서 확정된 사실입니다. 틀린 절은 지워도 됩니다.\n<!-- drawing: ${scope.key} -->\n`; }
    const current = parseKnowledge(text).filter(fact => !fact.replaced);
    const now = new Date();
    const stamp = now.toISOString().slice(0, 10).replace(/-/g, "");
    const local = now.toLocaleString("sv-SE").slice(0, 16);
    let next = parseKnowledge(text).filter(fact => fact.id.startsWith(`F-${stamp}-`)).length + 1;
    for (const proposal of proposals) {
      if (current.some(fact => fact.title === proposal.title && fact.content === proposal.content)) continue;
      const id = `F-${stamp}-${next++}`;
      if (proposal.replaces) text = markReplaced(text, proposal.replaces, id);
      text = text.trimEnd() + `\n\n## ${id} · ${proposal.title}\n- 내용: ${proposal.content}\n` +
        `- 근거: ${BASIS_LABEL[proposal.basis]}${proposal.evidence ? ` · ${proposal.evidence}` : ""}\n` +
        `- 기록: ${local} · ${source}\n`;
      added.push(id);
    }
    if (!added.length) return;
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file + ".tmp", text, "utf8");
    await rename(file + ".tmp", file);
  }).catch(error => {
    added.length = 0;
    process.stderr.write(`MyCivil3DMcp knowledge was not saved: ${String(error)}\n`);
  });
  await writing;
  return added;
}

function markReplaced(text: string, id: string, by: string): string {
  const start = text.indexOf(`## ${id} `);
  if (start < 0) return text;
  const end = text.indexOf("\n## ", start + 3);
  const section = text.slice(start, end < 0 ? undefined : end);
  if (section.includes("- 상태: 정정됨")) return text;
  const marked = section.trimEnd() + `\n- 상태: 정정됨 (${by})\n`;
  return text.slice(0, start) + marked + (end < 0 ? "" : text.slice(end));
}
