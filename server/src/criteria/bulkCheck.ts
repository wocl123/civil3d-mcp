import { callPlugin } from "../bridge/pluginClient.js";
import { failureGuide } from "../errors/failureGuide.js";
import { checkAlignmentCriteria } from "./alignmentCriteria.js";
import { checkProfileCriteria } from "./profileCriteria.js";
import type { CheckItem } from "./types/CheckItem.js";
import type { CriteriaReport } from "./types/CriteriaReport.js";
import { readRecord, writeRecord } from "../civil/alignmentRecord.js";

// Every alignment (and its design profiles) checked in one call, for questions about the
// whole drawing. Before this, the AI called the single check once per alignment: 39
// alignments took 39 tool calls, two minutes, and over 200k tokens. The result is a table
// of counts with the first few failures of each alignment; details and fixes come from
// check_alignment_criteria / check_profile_criteria on one alignment, so no fix ids are
// made here.
const PAGE = 200;
const CONCURRENCY = 3;
const MAX_FAILS = 3;

type AlignmentRow = {
  name: string; handle: string; type?: string; profileCount?: number; length?: number;
  startStationText?: string; endStationText?: string; description?: string | null;
};

// What list_alignments says about one alignment, so a "선형 정보" question needs no get_alignment per alignment.
function info(row: AlignmentRow): string {
  return [row.type, row.startStationText && row.endStationText ? `${row.startStationText}~${row.endStationText}` : undefined,
    row.length !== undefined ? `${Math.round(row.length * 100) / 100} m` : undefined,
    row.profileCount !== undefined ? `종단 ${row.profileCount}개` : undefined].filter(Boolean).join(" · ");
}
type Summary = CriteriaReport["summary"];

export type BulkInput = { criteria?: string; profiles?: boolean; offset?: number; limit?: number };

const add = (a: Summary, b: Summary): Summary =>
  ({ pass: a.pass + b.pass, fail: a.fail + b.fail, review: a.review + b.review, notChecked: a.notChecked + b.notChecked });
const empty = (): Summary => ({ pass: 0, fail: 0, review: 0, notChecked: 0 });
const counts = (summary: Summary) =>
  `통과 ${summary.pass} · 미달 ${summary.fail} · 검토 ${summary.review} · 판단불가 ${summary.notChecked}`;

function failLine(item: CheckItem): string {
  const sign = item.bound === "min" ? "≥" : item.bound === "max" ? "≤" : "";
  const value = item.actual !== undefined ? `: ${item.actual}${item.unit}${item.limit !== undefined ? ` (기준 ${sign} ${item.limit}${item.unit})` : ""}` : "";
  return `${item.article} ${item.check} · ${item.target}${value}`;
}

async function allAlignments(): Promise<AlignmentRow[]> {
  const rows: AlignmentRow[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const page = await callPlugin("alignment.list", { offset, limit: PAGE }) as { totalCount: number; items: AlignmentRow[] };
    rows.push(...page.items);
    if (rows.length >= page.totalCount || page.items.length === 0) return rows;
  }
}

async function checkOne(row: AlignmentRow, input: BulkInput) {
  const recorded = writeRecord(readRecord(row.description));
  const out: Record<string, unknown> = { name: row.name, info: info(row), ...(recorded ? { recorded } : {}) };
  const missing = new Set<string>();
  const fails: string[] = [];
  try {
    const plan = await checkAlignmentCriteria({ alignment: row.handle, ...(input.criteria ? { criteria: input.criteria } : {}) });
    if (plan.notes.some(note => note.includes("도로 기준으로 검토하지 않음"))) return { ...out, plan: "도로가 아니라 검토 안 함" };
    if (plan.conditions.designSpeed) out.designSpeed = typeof plan.conditions.designSpeed === "string" ? plan.conditions.designSpeed : plan.conditions.designSpeed.value;
    out.plan = counts(plan.summary);
    plan.missing.forEach(item => missing.add(item.name));
    fails.push(...plan.items.filter(item => item.result === "fail").map(failLine));
    out.planSummary = plan.summary;
  } catch (error) {
    out.plan = `오류(${failureGuide(error instanceof Error ? error.message : String(error)).kind})`;
  }
  if (input.profiles !== false && (row.profileCount ?? 1) > 0) {
    try {
      const reports = await checkProfileCriteria({ alignment: row.handle, ...(input.criteria ? { criteria: input.criteria } : {}) });
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
  if (missing.size) out.missing = [...missing];
  if (fails.length) out.fails = [...fails.slice(0, MAX_FAILS), ...(fails.length > MAX_FAILS ? [`그 밖에 ${fails.length - MAX_FAILS}건`] : [])];
  return out;
}

export async function checkAllAlignments(input: BulkInput) {
  const everything = await allAlignments();
  const offset = input.offset ?? 0;
  const rows = everything.slice(offset, offset + (input.limit ?? 60));
  const results: Record<string, unknown>[] = new Array(rows.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, rows.length) }, async () => {
    while (next < rows.length) { const index = next++; results[index] = await checkOne(rows[index], input); }
  }));

  const plan = results.reduce<Summary>((sum, row) => row.planSummary ? add(sum, row.planSummary as Summary) : sum, empty());
  const profile = results.reduce<Summary>((sum, row) => row.profileSummary ? add(sum, row.profileSummary as Summary) : sum, empty());
  const missing: Record<string, number> = {};
  for (const row of results) for (const name of (row.missing as string[] | undefined) ?? []) missing[name] = (missing[name] ?? 0) + 1;
  return {
    alignments: everything.length,
    checked: rows.length,
    ...(offset + rows.length < everything.length ? { nextOffset: offset + rows.length } : {}),
    totals: {
      plan: counts(plan), profile: counts(profile),
      withFails: results.filter(row => row.fails).length,
      notRoad: results.filter(row => row.plan === "도로가 아니라 검토 안 함").length,
      errors: results.filter(row => String(row.plan).startsWith("오류") || String(row.profile ?? "").startsWith("오류")).length,
      ...(Object.keys(missing).length ? { missingConditions: missing } : {})
    },
    rows: results.map(({ planSummary, profileSummary, ...row }) => row),
    next: "Each row already has the alignment's type, stations, length, profile count, recorded conditions, and design speed; do not call get_alignment for a summary. Details, all items, and fixes: check_alignment_criteria / check_profile_criteria on one alignment. missingConditions counts alignments whose check lacked that condition (record it on the alignment or give it)."
  };
}
