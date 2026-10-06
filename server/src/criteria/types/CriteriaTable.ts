// A limit taken from one table of a criteria document. A value is a lower bound
// ("min": actual must be at least the value) or an upper bound ("max"). A value of
// { divideByDeltaDeg: n } means n ÷ the curve's deflection angle in degrees.
export type CriteriaValue = number | { divideByDeltaDeg: number };

export type CriteriaRow = {
  when: Record<string, string | number>;
  value: CriteriaValue;
  // The source text line this row was taken from; law:fetch checks it is still in the law.
  source: string;
};

export type CriteriaTable = {
  id: string; article: string; title: string; unit: string; bound: "min" | "max";
  keys: string[]; note?: string; rows: CriteriaRow[];
  // How far the limit may be relaxed by the article's proviso (such as 제8조① 단서: 20 km/h less).
  relax?: number;
  // Set when a set extends another: the short name of the document the table comes from.
  document?: string;
};
