// 전체 선형 일괄 검토 (check_all_alignments 도구).
// 모든 선형과 그 설계 종단을 한 번에 검토하고, 선형마다 개수와 첫 미달 몇 건만 표로 돌려준다.
//
// 만든 이유: 예전에는 AI가 선형마다 단일 검토를 따로 불러서
// 선형 39개에 도구 호출 39번, 2분, 20만 토큰이 들었다.
// 자세한 항목과 수정안은 고른 선형 하나에 단일 검토로 받으므로, 여기서는 수정안 id를 만들지 않는다.

import { callPlugin } from "../bridge/pluginClient.js";
import { failureGuide } from "../errors/failureGuide.js";
import { checkAlignmentCriteria } from "./alignmentCriteria.js";
import { checkProfileCriteria } from "./profileCriteria.js";
import type { CheckItem } from "./types/CheckItem.js";
import type { CriteriaReport } from "./types/CriteriaReport.js";
import { readRecord, writeRecord } from "../civil/alignmentRecord.js";

const PAGE = 200;        // 선형 목록을 한 번에 읽는 개수
const CONCURRENCY = 3;   // 동시에 검토하는 선형 수
const MAX_FAILS = 3;     // 선형마다 보여 줄 미달 항목 수

// 선형 목록(alignment.list)의 한 줄.
type AlignmentRow = {
  name: string;
  handle: string;
  type?: string;
  profileCount?: number;
  length?: number;
  startStationText?: string;
  endStationText?: string;
  description?: string | null;
};

type Summary = CriteriaReport["summary"];

export type BulkInput = { criteria?: string; profiles?: boolean; offset?: number; limit?: number };

// 선형 기본 정보 한 줄: "Centerline · 0+000.00~0+661.02 · 661.02 m · 종단 2개".
// "선형 정보" 질문에 선형마다 get_alignment 를 다시 부르지 않게 결과에 넣는다.
function info(row: AlignmentRow): string {
  return [
    row.type,
    row.startStationText && row.endStationText ? `${row.startStationText}~${row.endStationText}` : undefined,
    row.length !== undefined ? `${Math.round(row.length * 100) / 100} m` : undefined,
    row.profileCount !== undefined ? `종단 ${row.profileCount}개` : undefined
  ].filter(Boolean).join(" · ");
}

// 검토 개수 더하기 / 0으로 시작 / 한 줄로 쓰기
const add = (a: Summary, b: Summary): Summary => ({
  pass: a.pass + b.pass,
  fail: a.fail + b.fail,
  review: a.review + b.review,
  notChecked: a.notChecked + b.notChecked
});
const empty = (): Summary => ({ pass: 0, fail: 0, review: 0, notChecked: 0 });
const counts = (summary: Summary) =>
  `통과 ${summary.pass} · 미달 ${summary.fail} · 검토 ${summary.review} · 판단불가 ${summary.notChecked}`;

// 미달 항목 한 줄: "제19조 최소 평면곡선 반지름 · 곡선 2 (...): 85m (기준 ≥ 100m)".
function failLine(item: CheckItem): string {
  const sign = item.bound === "min" ? "≥" : item.bound === "max" ? "≤" : "";
  const limit = item.limit !== undefined ? ` (기준 ${sign} ${item.limit}${item.unit})` : "";
  const value = item.actual !== undefined ? `: ${item.actual}${item.unit}${limit}` : "";
  return `${item.article} ${item.check} · ${item.target}${value}`;
}

// 도면의 모든 선형을 페이지 단위로 읽는다.
async function allAlignments(): Promise<AlignmentRow[]> {
  const rows: AlignmentRow[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const page = await callPlugin("alignment.list", { offset, limit: PAGE }) as { totalCount: number; items: AlignmentRow[] };
    rows.push(...page.items);
    if (rows.length >= page.totalCount || page.items.length === 0) return rows;
  }
}

// 선형 하나: 평면 검토와 종단 검토를 돌리고, 개수·빠진 조건·첫 미달 항목만 남긴다.
async function checkOne(row: AlignmentRow, input: BulkInput) {
  const recorded = writeRecord(readRecord(row.description));
  const out: Record<string, unknown> = { name: row.name, info: info(row), ...(recorded ? { recorded } : {}) };
  const missing = new Set<string>();
  const fails: string[] = [];
  const criteria = input.criteria ? { criteria: input.criteria } : {};

  // 1) 평면선형 검토
  try {
    const plan = await checkAlignmentCriteria({ alignment: row.handle, ...criteria });
    if (plan.notes.some(note => note.includes("도로 기준으로 검토하지 않음")))
      return { ...out, plan: "도로가 아니라 검토 안 함" };

    if (plan.conditions.designSpeed) {
      const speed = plan.conditions.designSpeed;
      out.designSpeed = typeof speed === "string" ? speed : speed.value;
    }
    out.plan = counts(plan.summary);
    out.planSummary = plan.summary;
    plan.missing.forEach(item => missing.add(item.name));
    fails.push(...plan.items.filter(item => item.result === "fail").map(failLine));
  } catch (error) {
    out.plan = `오류(${failureGuide(error instanceof Error ? error.message : String(error)).kind})`;
  }

  // 2) 종단 검토 (설계 종단이 있을 때만)
  if (input.profiles !== false && (row.profileCount ?? 1) > 0) {
    try {
      const reports = await checkProfileCriteria({ alignment: row.handle, ...criteria });
      const summary = reports.reduce((sum, report) => add(sum, report.summary), empty());
      out.profile = `${reports.length}개 · ${counts(summary)}`;
      out.profileSummary = summary;
      reports.forEach(report => report.missing.forEach(item => missing.add(item.name)));
      fails.push(...reports.flatMap(report => report.items.filter(item => item.result === "fail").map(failLine)));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      out.profile = /no design profile/.test(message) ? "설계 종단 없음" : `오류(${failureGuide(message).kind})`;
    }
  }

  // 3) 빠진 조건과 첫 미달 몇 건
  if (missing.size) out.missing = [...missing];
  if (fails.length) {
    out.fails = [
      ...fails.slice(0, MAX_FAILS),
      ...(fails.length > MAX_FAILS ? [`그 밖에 ${fails.length - MAX_FAILS}건`] : [])
    ];
  }
  return out;
}

export async function checkAllAlignments(input: BulkInput) {
  // 1) 대상 선형 (한 번에 최대 60개, 더 있으면 nextOffset 으로 이어서)
  const everything = await allAlignments();
  const offset = input.offset ?? 0;
  const rows = everything.slice(offset, offset + (input.limit ?? 60));

  // 2) CONCURRENCY 개씩 나눠 검토한다. 결과는 원래 순서대로 둔다.
  const results: Record<string, unknown>[] = new Array(rows.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, rows.length) }, async () => {
    while (next < rows.length) {
      const index = next++;
      results[index] = await checkOne(rows[index], input);
    }
  }));

  // 3) 합계: 평면·종단 개수, 미달 선형 수, 조건별로 빠진 선형 수
  const plan = results.reduce<Summary>((sum, row) => row.planSummary ? add(sum, row.planSummary as Summary) : sum, empty());
  const profile = results.reduce<Summary>((sum, row) => row.profileSummary ? add(sum, row.profileSummary as Summary) : sum, empty());
  const missing: Record<string, number> = {};
  for (const row of results)
    for (const name of (row.missing as string[] | undefined) ?? []) missing[name] = (missing[name] ?? 0) + 1;

  return {
    alignments: everything.length,
    checked: rows.length,
    ...(offset + rows.length < everything.length ? { nextOffset: offset + rows.length } : {}),
    totals: {
      plan: counts(plan),
      profile: counts(profile),
      withFails: results.filter(row => row.fails).length,
      notRoad: results.filter(row => row.plan === "도로가 아니라 검토 안 함").length,
      errors: results.filter(row => String(row.plan).startsWith("오류") || String(row.profile ?? "").startsWith("오류")).length,
      ...(Object.keys(missing).length ? { missingConditions: missing } : {})
    },
    // 합계 계산에만 쓴 개수 객체는 결과에서 뺀다.
    rows: results.map(({ planSummary, profileSummary, ...row }) => row),
    // AI에게 주는 안내(영어로 둔다: AI가 읽는 문장).
    next: "Each row already has the alignment's type, stations, length, profile count, recorded conditions, and design speed; " +
      "do not call get_alignment for a summary. Details, all items, and fixes: check_alignment_criteria / check_profile_criteria " +
      "on one alignment. missingConditions counts alignments whose check lacked that condition (record it on the alignment or give it)."
  };
}
