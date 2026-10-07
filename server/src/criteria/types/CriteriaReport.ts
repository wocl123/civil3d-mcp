import type { CheckItem } from "./CheckItem.js";

// 적용한 조건 값과 그 출처(질문 입력 / 도면 / 기준표).
export type ConditionValue = { value: string | number; from: "input" | "drawing" | "criteria" };

// 기준 검토 도구가 돌려주는 결과.
export type CriteriaReport = {
  // 쓴 기준과, 기준표가 원문과 얼마나 대조되었는지
  criteria: { id: string; title: string; effective?: string; reviewed: boolean; verification: string };

  assessment?: "pass" | "fail" | "review" | "incomplete" | "not_applicable";
  target: string;                                         // 검토 대상 (예: 선형 본선)
  conditions: Record<string, ConditionValue | string>;    // 적용한 조건과 출처
  missing: { name: string; options?: (string | number)[]; neededFor: string }[]; // 아직 필요한 조건

  summary: { pass: number; fail: number; review: number; notChecked: number };
  items: CheckItem[];
  omittedPasses?: number;   // 항목이 많아 목록에서 뺀 통과 항목 수
  notes: string[];

  // 이 검토가 비교하지 않는 항목. "모두 통과"를 전체 승인으로 읽지 않게 한다.
  notCovered: string[];
};
