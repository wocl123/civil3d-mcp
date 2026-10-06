import { callPlugin } from "../bridge/pluginClient.js";
import { gradeConditions, notRoadNote, readRecord, type AlignmentRecord } from "../civil/alignmentRecord.js";
import { loadParameters } from "../knowledge/parameters.js";
import { alignmentProfiles, readSection } from "../civil/civilData.js";
import type { AlignmentDesignSpeed } from "../civil/types/AlignmentDesignSpeed.js";
import type { ProfileCurve } from "../civil/types/ProfileCurve.js";
import type { ProfilePvi } from "../civil/types/ProfilePvi.js";
import type { ProfileSummary } from "../civil/types/ProfileSummary.js";
import type { ProfileTangent } from "../civil/types/ProfileTangent.js";
import { findRow, loadCriteria, options, table } from "./criteriaStore.js";
import { describeSpeeds, speedAt } from "./designSpeed.js";
import { gradeFixes, verticalCurveFixes } from "./fixes/profileFixes.js";
import { label, ReportBuilder } from "./reportBuilder.js";
import { round } from "../geometry.js";
import type { CriteriaReport } from "./types/CriteriaReport.js";
import type { CriteriaSet } from "./types/CriteriaSet.js";

export type ProfileCriteriaInput = {
  profile?: string; alignment?: string; criteria?: string;
  designSpeed?: number; roadFunction?: string; terrain?: string;
};

const definedOnly = <T extends object>(value: T) =>
  Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as Partial<T>;

// Parts of vertical alignment design this check does not compare. Owner manuals add theirs.
const NOT_COVERED = ["오르막차로", "합성경사(편경사와 종단경사)", "시거", "평면·종단 선형의 조합"];
const notCovered = (set: CriteriaSet) => [...NOT_COVERED,
  ...(set.tables.some(item => item.id === "intersection_max_grade") ? ["교차로 접속부 종단경사와 완만한 구간 길이(LH 지침 8.2.3)"] : [])];

// Surface profiles follow the ground and have no design grades or curves to check.
const UNCHECKED_TYPES = new Set(["EG"]);
// 제25조① proviso: up to 1% steeper where the terrain or the like requires it.
const GRADE_PROVISO = 1;

// Compares design profiles with a criteria set (by default 도로구조규칙 제25·27조).
// Without a profile, every design profile of the alignment is checked.
export async function checkProfileCriteria(input: ProfileCriteriaInput): Promise<CriteriaReport[]> {
  await loadParameters();
  const set = await loadCriteria(input.criteria ?? "도로구조규칙");
  let profiles: ProfileSummary[];
  if (input.profile) {
    const overview = await callPlugin("profile.get", { profile: input.profile, alignment: input.alignment }) as { profile: ProfileSummary };
    profiles = [overview.profile];
  } else if (input.alignment) {
    profiles = (await alignmentProfiles(input.alignment)).filter(profile => !UNCHECKED_TYPES.has(profile.type));
    if (profiles.length === 0) throw new Error(`Alignment "${input.alignment}" has no design profile to check.`);
  } else throw new Error("Give a profile, or an alignment to check all of its design profiles.");

  const speedsByAlignment = new Map<string, AlignmentDesignSpeed[]>();
  const notRoadByAlignment = new Map<string, string | undefined>();
  const recordByAlignment = new Map<string, AlignmentRecord>();
  const reports: CriteriaReport[] = [];
  for (const profile of profiles) {
    const alignment = profile.alignmentHandle ?? input.alignment;
    if (alignment && !speedsByAlignment.has(alignment)) {
      const overview = await callPlugin("alignment.get", { alignment }) as { alignment: { description?: string | null } };
      const record = readRecord(overview.alignment.description);
      notRoadByAlignment.set(alignment, notRoadNote(record.uses));
      recordByAlignment.set(alignment, record);
      speedsByAlignment.set(alignment, await readSection<AlignmentDesignSpeed>("alignment.section", { alignment }, "design_speeds"));
    }
    const notRoad = alignment ? notRoadByAlignment.get(alignment) : undefined;
    if (notRoad) {
      const skipped = new ReportBuilder(set, `종단 ${profile.name} (${profile.type}, 선형 ${profile.alignmentName ?? alignment})`);
      skipped.notes.push(notRoad);
      reports.push(skipped.build());
      continue;
    }
    // Conditions recorded on the alignment fill in what the question did not give.
    const record = alignment ? recordByAlignment.get(alignment) ?? {} : {};
    const filled: ProfileCriteriaInput = { ...gradeConditions(record), ...definedOnly(input) };
    const used = record.criteria && !input.criteria ? await loadCriteria(record.criteria) : set;
    const report = await checkOne(used, profile, filled, alignment ? speedsByAlignment.get(alignment)! : []);
    const from = Object.keys(gradeConditions(record)).filter(name => input[name as keyof ProfileCriteriaInput] === undefined);
    if (from.length || used !== set) report.notes.push(`선형 설명에 기록된 조건을 썼다: ${[
      ...(used !== set ? [`기준 ${used.id}`] : []), ...from.map(name => `${name} ${filled[name as keyof ProfileCriteriaInput]}`)].join(", ")}`);
    reports.push(report);
  }
  return reports;
}

async function checkOne(set: CriteriaSet, profile: ProfileSummary, input: ProfileCriteriaInput,
  speeds: AlignmentDesignSpeed[]): Promise<CriteriaReport> {
  const report = new ReportBuilder(set, `종단 ${profile.name} (${profile.type}, 선형 ${profile.alignmentName ?? input.alignment ?? "알 수 없음"})`, notCovered(set));
  const grade = table(set, "max_grade");
  const kTable = table(set, "min_vertical_k");
  const lengthTable = table(set, "min_vertical_length");
  if (UNCHECKED_TYPES.has(profile.type)) {
    report.notes.push("지표면 종단(EG)은 지반선이라 설계 기준 비교 대상이 아니다.");
    return report.build();
  }

  const key = { profile: profile.handle, alignment: profile.alignmentHandle };
  const [curves, tangents, pvis] = await Promise.all([
    readSection<ProfileCurve>("profile.section", key, "curves"),
    readSection<ProfileTangent>("profile.section", key, "tangents"),
    readSection<ProfilePvi>("profile.section", key, "pvis")
  ]);

  if (input.designSpeed !== undefined) report.conditions.designSpeed = { value: input.designSpeed, from: "input" };
  else if (speeds.length) report.conditions.designSpeed = describeSpeeds(undefined, speeds)!;
  else report.need("designSpeed", [grade, kTable, lengthTable].map(label).join(", "), options(kTable, "designSpeed"));
  for (const name of ["roadFunction", "terrain"] as const)
    if (input[name]) report.conditions[name] = { value: input[name]!, from: "input" };

  // 제27조: K at least the table's rate, and length at least the larger of K·A and the minimum length (①).
  for (const curve of curves) {
    const target = `곡선 ${curve.number} ${curve.crestOrSag === "Crest" ? "볼록" : "오목"} (VIP ${curve.pviStationText})`;
    const speed = speedAt(curve.startStation, input.designSpeed, speeds);
    if (!speed) continue;
    const form = curve.crestOrSag === "Crest" ? "볼록" : curve.crestOrSag === "Sag" ? "오목" : undefined;
    const kRow = form ? findRow(kTable, { designSpeed: speed.value, curveForm: form }) : undefined;
    const lengthRow = findRow(lengthTable, { designSpeed: speed.value });
    if (!kRow || typeof kRow.value !== "number") report.skip(kTable, target, form ? `표에 없는 설계속도 ${speed.value}` : "볼록·오목을 읽지 못함");
    else if (curve.k === undefined) report.skip(kTable, target, "K를 읽지 못함");
    // K below the rate also means the length is below K·A, so the fixes go with the length item.
    else report.compare(kTable, target, curve.k, kRow.value, { note: curve.k < kRow.value ? "수정안은 종단곡선 필요 길이 항목에 있음" : undefined });

    if (!lengthRow || typeof lengthRow.value !== "number") { report.skip(lengthTable, target, `표에 없는 설계속도 ${speed.value}`); continue; }
    const change = curve.gradeChangePercent === undefined ? undefined : Math.abs(curve.gradeChangePercent);
    if (typeof kRow?.value === "number" && change !== undefined) {
      const byRate = round(kRow.value * change);
      const required = Math.max(byRate, lengthRow.value);
      report.compare({ ...lengthTable, title: "종단곡선 필요 길이", article: "제27조①" }, target, curve.length, required,
        { note: `max(최소 K ${kRow.value} × 경사 차 ${round(change, 2)}% = ${byRate}, 최소 길이 ${lengthRow.value}) (계산값)`,
          fixes: () => verticalCurveFixes({ profile, curve, curves, pvis, minK: kRow.value as number, minLength: lengthRow.value as number }) });
    } else report.compare(lengthTable, target, curve.length, lengthRow.value);
  }

  // 제25조①: each straight grade at most the table's value.
  const missingGradeConditions = (["roadFunction", "terrain"] as const).filter(name => !input[name]);
  for (const name of missingGradeConditions) report.need(name, label(grade), options(grade, name));
  if (missingGradeConditions.length === 0) {
    for (const tangent of tangents) {
      const target = `경사 ${tangent.number} (${tangent.startStationText}~${tangent.endStationText})`;
      const speed = speedAt(tangent.startStation, input.designSpeed, speeds);
      if (!speed || tangent.gradePercent === undefined) continue;
      const row = findRow(grade, { designSpeed: speed.value, roadFunction: input.roadFunction!, terrain: input.terrain! });
      if (!row || typeof row.value !== "number") { report.skip(grade, target, `표에 없는 조건 (설계속도 ${speed.value}, ${input.roadFunction}, ${input.terrain})`); continue; }
      const actual = Math.abs(tangent.gradePercent);
      const withinProviso = actual > row.value && actual <= row.value + GRADE_PROVISO;
      report.compare(grade, target, actual, row.value, {
        proviso: GRADE_PROVISO,
        ...(withinProviso ? { note: "표의 값 + 1% 이내. 제25조① 단서 적용 여부는 사람이 판단" } : {}),
        fixes: limit => gradeFixes(profile, tangent, pvis, limit)
      });
    }
  }

  if (curves.length === 0) report.notes.push("종단곡선이 없는 종단이다.");
  return report.build();
}
