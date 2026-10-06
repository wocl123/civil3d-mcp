// The last numbered list each palette conversation was shown (/후보 or /검토), so a reply
// such as "1, 3 승인" decides items of that list and not of another one shown earlier.
export type ListKind = "candidates" | "review";

const shown = new Map<string, { kind: ListKind; ids: string[] }>();
const MAX = 100;

export function setShown(conversation: string | undefined, kind: ListKind, ids: string[]): void {
  const key = conversation ?? "default";
  shown.delete(key);
  shown.set(key, { kind, ids });
  for (const old of shown.keys()) { if (shown.size <= MAX) break; shown.delete(old); }
}

export function lastShown(conversation: string | undefined, kind: ListKind): string[] | undefined {
  const found = shown.get(conversation ?? "default");
  return found?.kind === kind ? found.ids : undefined;
}

// "1, 3 승인", "모두 반려", "2번 반려 중복이라서" → which numbers, the decision, and the rest as a reason.
const REPLY = /^(모두|전부|[\d\s,번]+?)\s*(승인|반려)\s*(?:해\s*줘|해|합니다)?[.!]?\s*(.*)$/;

export function parseDecision(text: string): { which: string; decision: "approved" | "rejected"; reason: string } | undefined {
  const match = REPLY.exec(text.trim());
  if (!match) return undefined;
  return { which: match[1].trim(), decision: match[2] === "승인" ? "approved" : "rejected", reason: match[3].trim() };
}

// The ids the numbers point at; "모두" means every listed id.
export function pick(which: string, order: string[]): string[] {
  if (/^(모두|전부)$/.test(which)) return order;
  return which.split(/[\s,번]+/).filter(Boolean).map(part => order[Number(part) - 1]).filter((id): id is string => !!id);
}
