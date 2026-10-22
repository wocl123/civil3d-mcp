// 플러그인이 검증·정규화한 Civil 객체 및 화면 작업 계획.
export type CivilPlan = {
  request: Record<string, unknown>;
  fingerprint: string;
  summary: string;
  details: string[];
  kind: "create" | "change" | "delete";
};
