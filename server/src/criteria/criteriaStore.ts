import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { knowledgeDir } from "../knowledge/knowledgeStore.js";
import type { CriteriaSet } from "./types/CriteriaSet.js";
import type { CriteriaRow, CriteriaTable } from "./types/CriteriaTable.js";

// Criteria sets live in data/knowledge/criteria as JSON. law:fetch keeps the law set
// there up to date; when it has never run, the copy shipped with the server is used.
const defaultsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "knowledge-defaults", "criteria");

// Criteria sets the tools offer. Each has a JSON file in knowledge-defaults/criteria.
export const CRITERIA_SETS = ["도로구조규칙", "LH_설계지침_토목"] as const;

export function criteriaDir(): string {
  return join(knowledgeDir(), "criteria");
}

// A set that extends another (an owner's manual over the law) gets the other set's tables
// it does not define itself; each table then names the document it comes from.
export async function loadCriteria(id: string): Promise<CriteriaSet> {
  if (!/^[\w가-힣.-]{1,80}$/.test(id)) throw new Error(`Invalid criteria id "${id}".`);
  let set: CriteriaSet | undefined;
  for (const dir of [criteriaDir(), defaultsDir]) {
    try { set = JSON.parse(await readFile(join(dir, `${id}.json`), "utf8")) as CriteriaSet; break; }
    catch { /* Try the next location. */ }
  }
  if (!set) throw new Error(`Criteria "${id}" was not found.`);
  if (!set.extends) return set;
  const base = await loadCriteria(set.extends);
  const own = new Set(set.tables.map(item => item.id));
  return {
    ...set,
    tables: [
      ...set.tables.map(item => ({ ...item, document: set!.short ?? set!.title })),
      ...base.tables.filter(item => !own.has(item.id)).map(item => ({ ...item, document: item.document ?? base.short ?? base.id }))
    ],
    base: { id: base.id, title: base.title, short: base.short, reviewed: base.reviewed, verification: base.verification, effective: base.source.effective }
  };
}

export function table(set: CriteriaSet, id: string): CriteriaTable {
  const found = set.tables.find(item => item.id === id);
  if (!found) throw new Error(`Criteria "${set.id}" has no table "${id}".`);
  return found;
}

export function findRow(source: CriteriaTable, when: Record<string, string | number>): CriteriaRow | undefined {
  return source.rows.find(row => source.keys.every(key => row.when[key] === when[key]));
}

// Values of one condition that appear in a table, so a missing condition can be asked with its options.
export function options(source: CriteriaTable, key: string): (string | number)[] {
  return [...new Set(source.rows.map(row => row.when[key]))];
}

export function verificationText(set: Pick<CriteriaSet, "kind" | "verification" | "base" | "short" | "title">): string {
  const own = set.kind !== "law" ? "문서 원문과 사람 대조 전 (기준표 검토 필요)"
    : !set.verification ? "법령 원문 대조 전"
    : set.verification.status === "matched" ? `${set.verification.lawEffective} 시행 원문과 일치`
    : `원문 불일치 ${set.verification.mismatches.length}건 (법령 개정 가능성, 기준표 재확인 필요)`;
  return set.base ? `${own}; 따르는 ${set.base.short ?? set.base.id}: ${verificationText({ ...set.base, kind: "law" })}` : own;
}
