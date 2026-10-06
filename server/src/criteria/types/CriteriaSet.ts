import type { CriteriaTable } from "./CriteriaTable.js";

// One criteria document (a law, an owner's design manual, or a company standard) as data.
export type CriteriaSet = {
  id: string; title: string; authority: string; kind: "law" | "owner" | "company";
  source: { lawId?: string; mst?: string; effective?: string; promulgation?: string; document?: string };
  // Set by people after comparing the tables with the source document.
  reviewed: boolean;
  // Set by law:fetch after checking every row's source line against the current law text.
  verification?: { status: "matched" | "mismatch"; checkedAt: string; lawEffective: string; mismatches: string[] };
  tables: CriteriaTable[];
  // Short name for citations, such as "LH 지침".
  short?: string;
  // An owner's manual that defers to a law names it here; its tables fill in what the manual leaves out.
  extends?: string;
  notes?: string[];
  // Set when loaded: the set this one extends.
  base?: Pick<CriteriaSet, "id" | "title" | "reviewed" | "verification" | "short"> & { effective?: string };
};
