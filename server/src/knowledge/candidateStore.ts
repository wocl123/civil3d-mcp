import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeAtomic } from "../files.js";
import { knowledgeDir } from "./knowledgeStore.js";
import { rulesDir } from "./rulesStore.js";
import type { FactProposal } from "./types/FactProposal.js";

// General knowledge goes through people before the AI uses it. When the user states a
// practice that holds beyond one drawing ("반지름은 10 m 단위로 올린다"), the AI proposes
// it as a candidate; candidates are only stored. A person lists them with /후보 and
// approves or rejects them; approved ones are added to the common rule
// 승인된_지식.md, which goes into every request. A misunderstanding in one
// conversation therefore never spreads to every drawing on its own.
export type Candidate = {
  id: string; title: string; content: string; evidence: string;
  drawing: string; provider: string; at: string;
  status: "pending" | "approved" | "rejected"; decidedAt?: string;
};

const file = () => join(knowledgeDir(), "candidates.json");
export const APPROVED_RULE = "승인된_지식";
const APPROVED_HEADER = `---
description: 사람이 승인한 일반 작업 관행. 매 요청에 함께 들어간다.
always: true
---
# 승인된 지식

사용자가 말하고 사람이 /후보에서 승인한 관행이다. 도면별 지식과 이번 질문의 사용자 말이 우선한다. 틀린 줄은 지워도 된다.
`;

let writing: Promise<unknown> = Promise.resolve();

async function load(): Promise<Candidate[]> {
  try { return JSON.parse(await readFile(file(), "utf8")) as Candidate[]; }
  catch { return []; }
}

const save = (list: Candidate[]) => writeAtomic(file(), JSON.stringify(list, null, 1));

// Stores new candidates; one the same as a pending or approved candidate is skipped.
export async function addCandidates(proposals: FactProposal[], drawing: string, provider: string): Promise<string[]> {
  if (!proposals.length) return [];
  const added: string[] = [];
  writing = writing.then(async () => {
    const list = await load();
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    let next = list.filter(item => item.id.startsWith(`C-${stamp}-`)).length + 1;
    for (const proposal of proposals) {
      if (list.some(item => item.status !== "rejected" && item.content === proposal.content)) continue;
      const id = `C-${stamp}-${next++}`;
      list.push({ id, title: proposal.title, content: proposal.content, evidence: proposal.evidence, drawing, provider,
        at: new Date().toISOString(), status: "pending" });
      added.push(id);
    }
    if (added.length) await save(list);
  }).catch(error => {
    added.length = 0;
    process.stderr.write(`MyCivil3DMcp knowledge candidates were not saved: ${String(error)}\n`);
  });
  await writing;
  return added;
}

export async function pendingCandidates(): Promise<Candidate[]> {
  return (await load()).filter(item => item.status === "pending");
}

// Approves or rejects candidates by id. Approved ones are appended to the approved-knowledge rule.
export async function decideCandidates(ids: string[], decision: "approved" | "rejected"): Promise<Candidate[]> {
  const decided: Candidate[] = [];
  writing = writing.then(async () => {
    const list = await load();
    const now = new Date();
    for (const item of list)
      if (ids.includes(item.id) && item.status === "pending") {
        item.status = decision;
        item.decidedAt = now.toISOString();
        decided.push(item);
      }
    if (!decided.length) return;
    if (decision === "approved") {
      const rule = join(rulesDir(), `${APPROVED_RULE}.md`);
      const text = await readFile(rule, "utf8").catch(() => APPROVED_HEADER);
      const date = now.toLocaleString("sv-SE").slice(0, 10);
      const lines = decided.map(item => `- ${item.content} (${item.id}, 승인 ${date})`).join("\n");
      await writeAtomic(rule, text.trimEnd() + "\n\n" + lines + "\n");
    }
    await save(list);
  }).catch(error => {
    decided.length = 0;
    process.stderr.write(`MyCivil3DMcp knowledge candidates were not decided: ${String(error)}\n`);
  });
  await writing;
  return decided;
}

// Size of the approved rule, which shares the always-included rules' room in every request.
export async function approvedSize(): Promise<number> {
  return (await readFile(join(rulesDir(), `${APPROVED_RULE}.md`), "utf8").catch(() => "")).length;
}
