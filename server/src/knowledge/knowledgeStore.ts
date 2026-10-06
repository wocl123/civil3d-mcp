// 도면별 지식 (data/knowledge/drawings/<도면이름>_<해시>.md).
//
// 지식은 두 층이다.
//   rules/    공통 규칙(모든 도면). rulesStore.ts
//   drawings/ 도면마다 마크다운 파일 하나. 사용자가 확정해 준 사실이나 도면에서 확인한 사실.
// 사람이 절을 고치거나 지워도 된다. 서비스는 새 절을 덧붙이고, 바뀐 절에 "정정됨" 표시만 하므로
// 앞선 결정이 어떻게 바뀌었는지 남는다.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeAtomic } from "../files.js";
import { dataDir } from "../paths.js";
import { hashKey } from "../memory/memoryStore.js";
import type { DrawingScope } from "../memory/types/DrawingScope.js";
import type { FactProposal } from "./types/FactProposal.js";
import type { KnowledgeFact } from "./types/KnowledgeFact.js";
import { validParameter } from "./parameters.js";

// 프롬프트에 넣는 사실 수와 글자 수 한도.
const MAX_PROMPT_FACTS = 30;
const MAX_PROMPT_CHARS = 4000;

const BASIS_LABEL: Record<KnowledgeFact["basis"], string> = { user_answer: "사용자 답변", drawing: "도면 확인" };

// 쓰기를 한 줄로 세운다.
let writing: Promise<void> = Promise.resolve();

export function knowledgeDir(): string {
  if (process.env.MY_CIVIL3D_KNOWLEDGE_DIR) return process.env.MY_CIVIL3D_KNOWLEDGE_DIR;
  return join(dataDir(), "knowledge");
}

// 도면의 지식 파일 경로. 도면 이름(파일에 쓸 수 없는 글자는 _) + 도면 경로의 해시 8자리.
export function knowledgeFile(scope: DrawingScope): string | undefined {
  if (!scope.key) return undefined;
  const name = scope.label.replace(/\.dwg$/i, "").replace(/[^\p{L}\p{N}_-]+/gu, "_").slice(0, 60) || "drawing";
  return join(knowledgeDir(), "drawings", `${name}_${hashKey(scope.key).slice(0, 8)}.md`);
}

function oneLine(text: string, max: number): string {
  return text.replace(/\s+/g, " ").trim().slice(0, max);
}

// 지식 파일 → 사실 목록. 절 하나("## F-20261006-1 · 제목")가 사실 하나.
// 사람이 손으로 쓴 절(id 없음)은 M-번호로 읽는다.
export function parseKnowledge(text: string): KnowledgeFact[] {
  return text.split(/^## /m).slice(1).map((section, index) => {
    const [header = "", ...lines] = section.split(/\r?\n/);
    const field = (name: string) => lines.find(line => line.startsWith(`- ${name}:`))?.slice(name.length + 3).trim();
    const id = /^(F-[\w-]+)/.exec(header)?.[1] ?? `M-${index + 1}`;
    const title = header.replace(/^F-[\w-]+\s*·\s*/, "").trim();
    const body = lines.filter(line => line.trim() && !/^- (근거|기록|상태):/.test(line)).join(" ");

    return {
      id,
      title,
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
  try {
    return parseKnowledge(await readFile(file, "utf8"));
  } catch {
    return [];
  }
}

// 프롬프트용 목록: 정정되지 않은 사실을 최신부터, 정해진 크기 안에서.
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

// AI가 스킬 지시에도 추측을 기록할 때가 있다. 추측하는 말투가 있으면 모든 AI에 똑같이 버린다.
const HEDGED = /추정|보인다|보임|것\s*같|듯하|아마|가능성|추측|probably|likely|seems|appears/i;

// AI가 <facts>에 쓴 항목 하나를 검사해 받는다. 형식이 틀리거나 추측이면 버린다.
function validProposal(value: unknown): FactProposal | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Record<string, unknown>;
  if (typeof item.title !== "string" || typeof item.content !== "string") return undefined;
  if (item.basis !== "user_answer" && item.basis !== "drawing") return undefined;

  const title = oneLine(item.title, 80);
  const content = oneLine(item.content, 400);
  if (!title || !content || HEDGED.test(content)) return undefined;

  // 일반 관행(scope: general)은 사용자 말에서만 나온다. 설정값은 일반 관행에만 붙는다.
  const general = item.scope === "general";
  if (general && item.basis !== "user_answer") return undefined;
  const parameter = general ? validParameter(item.parameter) : undefined;

  return {
    ...(general ? { scope: "general" as const } : {}),
    ...(parameter ? { parameter } : {}),
    title,
    content,
    basis: item.basis,
    evidence: typeof item.evidence === "string" ? oneLine(item.evidence, 200) : "",
    replaces: typeof item.replaces === "string" && /^F-[\w-]+$/.test(item.replaces) ? item.replaces : undefined
  };
}

// <facts> 배열 → 올바른 항목만(최대 5개).
export function readProposals(value: unknown): FactProposal[] {
  return Array.isArray(value)
    ? value.map(validProposal).filter((item): item is FactProposal => !!item).slice(0, 5)
    : [];
}

// 새 사실을 덧붙이고, 그 사실이 대신하는 옛 사실에 "정정됨"을 표시한다.
// 지금 사실과 똑같으면 건너뛴다(같은 답이 반복돼도 파일이 커지지 않게). 새 id들을 돌려준다.
export async function appendFacts(scope: DrawingScope, proposals: FactProposal[], source: string): Promise<string[]> {
  const file = knowledgeFile(scope);
  if (!file || !proposals.length) return [];
  const added: string[] = [];

  writing = writing.then(async () => {
    // 파일이 없으면 머리말부터 만든다.
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch {
      text = `# ${scope.label} 지식\n\n이 도면에서 확정된 사실입니다. 틀린 절은 지워도 됩니다.\n<!-- drawing: ${scope.key} -->\n`;
    }

    const current = parseKnowledge(text).filter(fact => !fact.replaced);
    const now = new Date();
    const stamp = now.toISOString().slice(0, 10).replace(/-/g, "");
    const local = now.toLocaleString("sv-SE").slice(0, 16);
    let next = parseKnowledge(text).filter(fact => fact.id.startsWith(`F-${stamp}-`)).length + 1;

    for (const proposal of proposals) {
      if (current.some(fact => fact.title === proposal.title && fact.content === proposal.content)) continue;
      const id = `F-${stamp}-${next++}`;
      if (proposal.replaces) text = markReplaced(text, proposal.replaces, id);

      const evidence = proposal.evidence ? ` · ${proposal.evidence}` : "";
      text = text.trimEnd() +
        `\n\n## ${id} · ${proposal.title}\n` +
        `- 내용: ${proposal.content}\n` +
        `- 근거: ${BASIS_LABEL[proposal.basis]}${evidence}\n` +
        `- 기록: ${local} · ${source}\n`;
      added.push(id);
    }

    if (!added.length) return;
    await writeAtomic(file, text);
  }).catch(error => {
    added.length = 0;
    process.stderr.write(`MyCivil3DMcp knowledge was not saved: ${String(error)}\n`);
  });

  await writing;
  return added;
}

// 절 id의 끝에 "- 상태: 정정됨 (새 id)"를 붙인다. 이미 붙어 있으면 그대로.
function markReplaced(text: string, id: string, by: string): string {
  const start = text.indexOf(`## ${id} `);
  if (start < 0) return text;
  const end = text.indexOf("\n## ", start + 3);
  const section = text.slice(start, end < 0 ? undefined : end);
  if (section.includes("- 상태: 정정됨")) return text;
  const marked = section.trimEnd() + `\n- 상태: 정정됨 (${by})\n`;
  return text.slice(0, start) + marked + (end < 0 ? "" : text.slice(end));
}
