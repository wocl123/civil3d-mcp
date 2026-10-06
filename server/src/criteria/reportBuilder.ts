// 검토 결과(CriteriaReport)를 만드는 도구.
// 비교 항목마다 기준표를 이름으로 지정하므로, 조문·단위·기준 방향(이상/이하)은 항상 기준 데이터에서 온다.

import { round } from "../geometry.js";
import { verificationText } from "./criteriaStore.js";
import type { CheckItem } from "./types/CheckItem.js";
import type { FixOption } from "./types/FixOption.js";
import type { CriteriaSet } from "./types/CriteriaSet.js";
import type { CriteriaTable, CriteriaValue } from "./types/CriteriaTable.js";
import type { ConditionValue, CriteriaReport } from "./types/CriteriaReport.js";

// 항목이 이보다 많으면 통과 항목은 개수만 세고, 미달·판단불가 항목만 나열한다.
const MAX_LISTED = 40;

// 검토 이름: "제19조 최소 평면곡선 반지름"처럼 조문과 제목을 함께 쓴다.
// 다른 기준을 따르는 기준(예: LH 지침)이면 문서 약칭을 앞에 붙인다.
export const label = (source: Pick<CriteriaTable, "article" | "title" | "document">) =>
  `${source.document ? `${source.document} ` : ""}${source.article} ${source.title}`;

// 조문만: "제19조", 또는 문서 약칭을 붙여 "LH 지침 8.1.3 나".
const cite = (source: Pick<CriteriaTable, "article" | "document">) =>
  source.document ? `${source.document} ${source.article}` : source.article;

// 결과에 붙는 기준 정보: 어떤 기준을 썼고, 기준표가 원문과 얼마나 대조되었는지.
export const criteriaHeader = (set: CriteriaSet): CriteriaReport["criteria"] => ({
  id: set.id,
  title: set.title,
  effective: set.source.effective?.replace(/^(\d{4})(\d{2})(\d{2})$/, "$1-$2-$3"),
  reviewed: set.reviewed,
  verification: verificationText(set)
});

// 검토 대상 하나(선형 하나, 종단 하나)의 비교 결과를 모은다.
export class ReportBuilder {
  private readonly items: CheckItem[] = [];
  private readonly missing = new Map<string, CriteriaReport["missing"][number]>();
  readonly notes: string[] = [];
  readonly conditions: Record<string, ConditionValue | string> = {};

  constructor(
    private readonly set: CriteriaSet,
    private readonly target: string,
    private readonly notCovered: string[] = []
  ) {
    if (!set.reviewed) this.notes.push("기준표는 원문에서 옮긴 값이며 사람 검토 전이다.");
    this.notes.push(...(set.notes ?? []));
  }

  // 실제값을 기준값과 비교한다.
  //   bound "min": 실제값 ≥ 기준값이면 통과 / "max": 실제값 ≤ 기준값이면 통과
  //   proviso: 단서가 기준값에서 더 허용하는 폭. 그 안이면 "review"(사람이 판단).
  //   fixes(limit): 미달일 때 고치는 방법을 계산하는 함수.
  compare(source: CriteriaTable, target: string, actual: number, value: CriteriaValue,
    extra: { deltaDeg?: number; note?: string; proviso?: number; fixes?: (limit: number) => FixOption[] } = {}): void {
    let limit: number;
    let note = extra.note;

    // 기준값이 "상수 ÷ 교각" 형태면(제20조 교각 5도 미만) 교각으로 나눠 구한다.
    if (typeof value === "number") {
      limit = value;
    } else {
      if (!extra.deltaDeg) return this.skip(source, target, "교각을 읽지 못해 비교하지 못함");
      limit = round(value.divideByDeltaDeg / extra.deltaDeg);
      note = [`${value.divideByDeltaDeg} ÷ 교각 ${round(extra.deltaDeg, 4)}° (계산값)`, note].filter(Boolean).join("; ");
    }

    const pass = source.bound === "min" ? actual >= limit : actual <= limit;

    // 단서가 허용하는 한계(기준값 ± 단서 폭) 안이면 review.
    const allowed = source.bound === "min" ? limit - (extra.proviso ?? 0) : limit + (extra.proviso ?? 0);
    const review = !pass && !!extra.proviso && (source.bound === "min" ? actual >= allowed : actual <= allowed);

    const fixes = !pass && extra.fixes ? extra.fixes(limit) : [];

    this.items.push({
      check: source.title,
      article: cite(source),
      target,
      actual: round(actual),
      limit,
      unit: source.unit,
      bound: source.bound,
      result: pass ? "pass" : review ? "review" : "fail",
      ...(note ? { note } : {}),
      ...(fixes.length ? { fixes } : {})
    });
  }

  // 있어야 할 요소가 없다(예: 완화곡선이 필요한데 없음). 항상 미달.
  missingElement(source: Pick<CriteriaTable, "title" | "article" | "unit" | "document">, target: string,
    note: string, fixes: FixOption[] = []): void {
    this.items.push({
      check: source.title, article: cite(source), target, unit: source.unit, result: "fail", note,
      ...(fixes.length ? { fixes } : {})
    });
  }

  // 비교하지 못한 항목(n/a). note에 이유를 적는다.
  skip(source: Pick<CriteriaTable, "title" | "article" | "unit" | "document">, target: string, note: string): void {
    this.items.push({ check: source.title, article: cite(source), target, unit: source.unit, result: "n/a", note });
  }

  // 검토에 필요한데 빠진 조건. 같은 조건이 여러 번 필요하면 용도만 덧붙인다.
  need(name: string, neededFor: string, choices?: (string | number)[]): void {
    const entry = this.missing.get(name);
    if (entry) {
      if (!entry.neededFor.includes(neededFor)) entry.neededFor += `, ${neededFor}`;
      return;
    }
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
      summary: { pass: count("pass"), fail: count("fail"), review: count("review"), notChecked: count("n/a") },
      items,
      ...(listAll ? {} : { omittedPasses: count("pass") }),
      notes: this.notes,
      notCovered: this.notCovered
    };
  }
}
