import type { CriteriaTable } from "./CriteriaTable.js";

// 기준 문서 하나(법령, 발주처 설계지침, 회사 기준)를 데이터로 옮긴 것.
export type CriteriaSet = {
  id: string;
  title: string;
  authority: string;
  kind: "law" | "owner" | "company";
  source: { lawId?: string; mst?: string; effective?: string; promulgation?: string; document?: string };

  // 사람이 기준표를 원문과 대조한 뒤 true로 바꾼다.
  reviewed: boolean;

  // law:fetch 가 행마다 원문 줄을 현행 법령과 대조한 결과.
  verification?: { status: "matched" | "mismatch"; checkedAt: string; lawEffective: string; mismatches: string[] };

  tables: CriteriaTable[];

  // 인용할 때 쓰는 약칭 (예: "LH 지침").
  short?: string;

  // 법령을 따르는 지침이면 따르는 기준의 id. 지침에 없는 표는 그 기준에서 가져온다.
  extends?: string;

  notes?: string[];

  // 읽을 때 채워진다: 따르는 기준의 요약.
  base?: Pick<CriteriaSet, "id" | "title" | "reviewed" | "verification" | "short"> & { effective?: string };
};
