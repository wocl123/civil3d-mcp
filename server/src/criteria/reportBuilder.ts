import { round } from "../geometry.js";
import { verificationText } from "./criteriaStore.js";
import type { CheckItem } from "./types/CheckItem.js";
import type { FixOption } from "./types/FixOption.js";
import type { CriteriaSet } from "./types/CriteriaSet.js";
import type { CriteriaTable, CriteriaValue } from "./types/CriteriaTable.js";
import type { ConditionValue, CriteriaReport } from "./types/CriteriaReport.js";

// Above this many items only failures and unchecked items are listed; passes are counted.
const MAX_LISTED = 40;

// "제19조 최소 평면곡선 반지름": names a check by article and title, never by article alone.
// With a set that extends another, the document's short name comes first: "LH 지침 8.1.3 나 …", "도로구조규칙 제19조 …".
export const label = (source: Pick<CriteriaTable, "article" | "title" | "document">) =>
  `${source.document ? `${source.document} ` : ""}${source.article} ${source.title}`;

// "LH 지침 8.1.3 나" or "도로구조규칙 제19조" when the set extends another, else just the article.
const cite = (source: Pick<CriteriaTable, "article" | "document">) => source.document ? `${source.document} ${source.article}` : source.article;

// Which criteria a report or plan used, and how far its tables have been checked.
export const criteriaHeader = (set: CriteriaSet): CriteriaReport["criteria"] => ({
  id: set.id, title: set.title, effective: set.source.effective?.replace(/^(\d{4})(\d{2})(\d{2})$/, "$1-$2-$3"),
  reviewed: set.reviewed, verification: verificationText(set)
});

// Collects comparison items for one target. Each check names its criteria table,
// so the article, unit, and bound always come from the criteria data.
export class ReportBuilder {
  private readonly items: CheckItem[] = [];
  private readonly missing = new Map<string, CriteriaReport["missing"][number]>();
  readonly notes: string[] = [];
  readonly conditions: Record<string, ConditionValue | string> = {};

  constructor(private readonly set: CriteriaSet, private readonly target: string) {
    if (!set.reviewed) this.notes.push("기준표는 원문에서 옮긴 값이며 사람 검토 전이다.");
    this.notes.push(...(set.notes ?? []));
  }

  // Compares actual with the row's limit. bound "min": actual ≥ limit passes; "max": actual ≤ limit passes.
  // On a failure, fixes(limit) computes the ways to correct it.
  compare(source: CriteriaTable, target: string, actual: number, value: CriteriaValue,
    extra: { deltaDeg?: number; note?: string; fixes?: (limit: number) => FixOption[] } = {}): void {
    let limit: number;
    let note = extra.note;
    if (typeof value === "number") limit = value;
    else {
      if (!extra.deltaDeg) return this.skip(source, target, "교각을 읽지 못해 비교하지 못함");
      limit = round(value.divideByDeltaDeg / extra.deltaDeg);
      note = [`${value.divideByDeltaDeg} ÷ 교각 ${round(extra.deltaDeg, 4)}° (계산값)`, note].filter(Boolean).join("; ");
    }
    const pass = source.bound === "min" ? actual >= limit : actual <= limit;
    const fixes = !pass && extra.fixes ? extra.fixes(limit) : [];
    this.items.push({ check: source.title, article: cite(source), target, actual: round(actual), limit, unit: source.unit,
      bound: source.bound, result: pass ? "pass" : "fail", ...(note ? { note } : {}), ...(fixes.length ? { fixes } : {}) });
  }

  // A required element is absent, such as a spiral where the criteria require one.
  missingElement(source: Pick<CriteriaTable, "title" | "article" | "unit" | "document">, target: string, note: string, fixes: FixOption[] = []): void {
    this.items.push({ check: source.title, article: cite(source), target, unit: source.unit, result: "fail", note,
      ...(fixes.length ? { fixes } : {}) });
  }

  skip(source: Pick<CriteriaTable, "title" | "article" | "unit" | "document">, target: string, note: string): void {
    this.items.push({ check: source.title, article: cite(source), target, unit: source.unit, result: "n/a", note });
  }

  need(name: string, neededFor: string, choices?: (string | number)[]): void {
    const entry = this.missing.get(name);
    if (entry) { if (!entry.neededFor.includes(neededFor)) entry.neededFor += `, ${neededFor}`; return; }
    this.missing.set(name, { name, neededFor, ...(choices ? { options: choices } : {}) });
  }

  build(): CriteriaReport {
    const count = (result: CheckItem["result"]) => this.items.filter(item => item.result === result).length;
    const listAll = this.items.length <= MAX_LISTED;
    const items = listAll ? this.items : this.items.filter(item => item.result !== "pass");
    return {
      criteria: criteriaHeader(this.set),
      target: this.target,
      conditions: this.conditions,
      missing: [...this.missing.values()],
      summary: { pass: count("pass"), fail: count("fail"), notChecked: count("n/a") },
      items,
      ...(listAll ? {} : { omittedPasses: count("pass") }),
      notes: this.notes
    };
  }
}
