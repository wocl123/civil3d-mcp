// 기준표(criteria set) 읽기.
// 기준표는 data/knowledge/criteria 의 JSON 파일이다. law:fetch 가 법령 기준표를 최신으로 유지하고,
// 한 번도 실행하지 않았으면 서버와 함께 배포된 사본(knowledge-defaults/criteria)을 쓴다.

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { knowledgeDir } from "../knowledge/knowledgeStore.js";
import type { CriteriaSet } from "./types/CriteriaSet.js";
import type { CriteriaRow, CriteriaTable } from "./types/CriteriaTable.js";

const defaultsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "knowledge-defaults", "criteria");

// 도구가 고를 수 있는 기준. 각각 knowledge-defaults/criteria 에 JSON 파일이 있다.
export const CRITERIA_SETS = ["도로구조규칙", "LH_설계지침_토목"] as const;

export function criteriaDir(): string {
  return join(knowledgeDir(), "criteria");
}

// 기준 하나를 읽는다.
// 다른 기준을 따르는 기준(예: LH 지침 → 도로구조규칙)은 자기에게 없는 표를 따르는 기준에서 가져오고,
// 표마다 어느 문서의 표인지(document) 적어 둔다.
export async function loadCriteria(id: string): Promise<CriteriaSet> {
  if (!/^[\w가-힣.-]{1,80}$/.test(id)) throw new Error(`Invalid criteria id "${id}".`);

  // 데이터 폴더의 사본이 먼저, 없으면 배포된 기본값.
  let set: CriteriaSet | undefined;
  for (const dir of [criteriaDir(), defaultsDir]) {
    try {
      set = JSON.parse(await readFile(join(dir, `${id}.json`), "utf8")) as CriteriaSet;
      break;
    } catch {
      // 다음 위치를 본다.
    }
  }
  if (!set) throw new Error(`Criteria "${id}" was not found.`);
  if (!set.extends) return set;

  // 따르는 기준의 표를 합친다. 같은 id의 표는 자기 것이 이긴다.
  const base = await loadCriteria(set.extends);
  const own = new Set(set.tables.map(item => item.id));
  return {
    ...set,
    tables: [
      ...set.tables.map(item => ({ ...item, document: set!.short ?? set!.title })),
      ...base.tables
        .filter(item => !own.has(item.id))
        .map(item => ({ ...item, document: item.document ?? base.short ?? base.id }))
    ],
    base: {
      id: base.id, title: base.title, short: base.short, reviewed: base.reviewed,
      verification: base.verification, effective: base.source.effective
    }
  };
}

// 기준에서 id로 표 하나를 찾는다. 없으면 오류(기준 데이터 문제).
export function table(set: CriteriaSet, id: string): CriteriaTable {
  const found = set.tables.find(item => item.id === id);
  if (!found) throw new Error(`Criteria "${set.id}" has no table "${id}".`);
  return found;
}

// 표에서 조건(설계속도, 최대 편경사 등)이 모두 맞는 행을 찾는다.
export function findRow(source: CriteriaTable, when: Record<string, string | number>): CriteriaRow | undefined {
  return source.rows.find(row => source.keys.every(key => row.when[key] === when[key]));
}

// 표에 나오는 조건 값들. 빠진 조건을 물을 때 선택지로 보여 준다.
export function options(source: CriteriaTable, key: string): (string | number)[] {
  return [...new Set(source.rows.map(row => row.when[key]))];
}

// 기준표가 원문과 얼마나 대조되었는지를 한 줄로.
export function verificationText(set: Pick<CriteriaSet, "kind" | "verification" | "base" | "short" | "title">): string {
  const own = set.kind !== "law" ? "문서 원문과 사람 대조 전 (기준표 검토 필요)"
    : !set.verification ? "법령 원문 대조 전"
    : set.verification.status === "matched" ? `${set.verification.lawEffective} 시행 원문과 일치`
    : `원문 불일치 ${set.verification.mismatches.length}건 (법령 개정 가능성, 기준표 재확인 필요)`;

  // 따르는 기준이 있으면 그 기준의 대조 상태도 덧붙인다.
  return set.base
    ? `${own}; 따르는 ${set.base.short ?? set.base.id}: ${verificationText({ ...set.base, kind: "law" })}`
    : own;
}
