// 지식 후보 저장소 (data/knowledge/candidates.json).
//
// 일반 지식은 사람을 거쳐야 AI가 쓴다.
//   1) 사용자가 도면 하나를 넘어서는 관행을 말하면("반지름은 10 m 단위로 올린다") AI가 후보로 남긴다.
//      후보는 저장만 되고 AI에게 가지 않는다.
//   2) 사람이 /후보 로 목록을 보고 승인·반려한다.
//   3) 승인된 것만 공통 규칙 승인된_지식.md 에 붙어 매 요청에 들어간다.
// 그래서 대화 하나의 오해가 저절로 모든 도면에 퍼지지 않는다.
//
// 설정값(parameter)이 붙은 후보는 승인하면 이 PC의 설정값도 바꾼다.
// 대기 중인 후보는 비식별 처리해 중앙 서버에도 보낸다(sync/syncLoop.ts). 보낸 시각은 submittedAt.
// 보내기 전에 이 PC에서 반려한 후보는 보내지 않는다.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeAtomic } from "../files.js";
import { knowledgeDir } from "./knowledgeStore.js";
import { rulesDir } from "./rulesStore.js";
import type { FactProposal } from "./types/FactProposal.js";
import { PARAMETERS, setLocalParameter, type ParameterKey } from "./parameters.js";

export type Candidate = {
  id: string;            // C-20261006-1
  title: string;
  content: string;
  evidence: string;      // 근거(사용자 말 인용). 중앙에는 보내지 않는다.
  drawing: string;
  provider: string;
  at: string;
  parameter?: { key: ParameterKey; value: number };
  status: "pending" | "approved" | "rejected";
  decidedAt?: string;
  submittedAt?: string;  // 중앙 서버에 보낸 시각
};

const file = () => join(knowledgeDir(), "candidates.json");

// 승인된 관행을 모으는 공통 규칙 파일(매 요청에 들어간다).
export const APPROVED_RULE = "승인된_지식";
const APPROVED_HEADER = `---
description: 사람이 승인한 일반 작업 관행. 매 요청에 함께 들어간다.
always: true
---
# 승인된 지식

사용자가 말하고 사람이 /후보에서 승인한 관행이다. 도면별 지식과 이번 질문의 사용자 말이 우선한다. 틀린 줄은 지워도 된다.
`;

// 쓰기를 한 줄로 세운다(동시에 두 요청이 파일을 덮어쓰지 않게).
let writing: Promise<unknown> = Promise.resolve();

async function load(): Promise<Candidate[]> {
  try {
    return JSON.parse(await readFile(file(), "utf8")) as Candidate[];
  } catch {
    return [];
  }
}

const save = (list: Candidate[]) => writeAtomic(file(), JSON.stringify(list, null, 1));

// 새 후보를 저장한다. 대기·승인된 후보와 내용이 같으면 건너뛴다. 새로 붙인 id들을 돌려준다.
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
      list.push({
        id,
        title: proposal.title,
        content: proposal.content,
        evidence: proposal.evidence,
        drawing,
        provider,
        ...(proposal.parameter ? { parameter: proposal.parameter } : {}),
        at: new Date().toISOString(),
        status: "pending"
      });
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

// id로 후보를 승인·반려한다.
// 승인하면 승인된_지식.md 에 한 줄씩 붙이고, 설정값이 있으면 이 PC의 설정값도 바꾼다.
export async function decideCandidates(ids: string[], decision: "approved" | "rejected"): Promise<Candidate[]> {
  const decided: Candidate[] = [];

  writing = writing.then(async () => {
    const list = await load();
    const now = new Date();
    for (const item of list) {
      if (ids.includes(item.id) && item.status === "pending") {
        item.status = decision;
        item.decidedAt = now.toISOString();
        decided.push(item);
      }
    }
    if (!decided.length) return;

    if (decision === "approved") {
      const rule = join(rulesDir(), `${APPROVED_RULE}.md`);
      const text = await readFile(rule, "utf8").catch(() => APPROVED_HEADER);
      const date = now.toLocaleString("sv-SE").slice(0, 10);
      const lines = decided.map(item => `- ${item.content} (${item.id}, 승인 ${date})`).join("\n");
      await writeAtomic(rule, text.trimEnd() + "\n\n" + lines + "\n");

      for (const item of decided)
        if (item.parameter) await setLocalParameter(item.parameter.key, item.parameter.value, item.id);
    }
    await save(list);
  }).catch(error => {
    decided.length = 0;
    process.stderr.write(`MyCivil3DMcp knowledge candidates were not decided: ${String(error)}\n`);
  });

  await writing;
  return decided;
}

// 아직 중앙 서버에 보내지 않은 후보(반려한 것은 빼고).
export async function unsentCandidates(): Promise<Candidate[]> {
  return (await load()).filter(item => !item.submittedAt && item.status !== "rejected");
}

// 중앙 서버에 보냈다고 표시한다.
export async function markSubmitted(ids: string[]): Promise<void> {
  writing = writing.then(async () => {
    const list = await load();
    const now = new Date().toISOString();
    for (const item of list) if (ids.includes(item.id)) item.submittedAt = now;
    await save(list);
  }).catch(error => process.stderr.write(`MyCivil3DMcp knowledge candidates were not updated: ${String(error)}\n`));
  await writing;
}

// 결정된 지 오래된 후보를 지운다(보관 기한). 대기 중인 후보는 항상 남긴다. 지운 개수를 돌려준다.
export async function pruneCandidates(maxAgeMs: number): Promise<number> {
  let removed = 0;
  writing = writing.then(async () => {
    const list = await load();
    const now = Date.now();
    const kept = list.filter(item =>
      item.status === "pending" || !item.decidedAt || now - Date.parse(item.decidedAt) < maxAgeMs);
    removed = list.length - kept.length;
    if (removed) await save(kept);
  }).catch(error => process.stderr.write(`MyCivil3DMcp knowledge candidates were not pruned: ${String(error)}\n`));
  await writing;
  return removed;
}

// 설정값을 사람이 읽는 한 줄로: "평면곡선 반지름 올림 단위(m) = 10".
export const parameterText = (parameter?: Candidate["parameter"]) =>
  parameter ? `${PARAMETERS[parameter.key].label} = ${parameter.value}` : undefined;

// 승인된_지식.md 의 크기. 매 요청에 들어가는 공통 규칙의 자리를 함께 쓰므로 너무 커지면 알린다.
export async function approvedSize(): Promise<number> {
  return (await readFile(join(rulesDir(), `${APPROVED_RULE}.md`), "utf8").catch(() => "")).length;
}
