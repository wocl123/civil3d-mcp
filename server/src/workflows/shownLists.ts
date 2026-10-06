// 대화마다 마지막으로 보여 준 번호 목록(/후보 또는 /검토)을 기억한다.
// 그래서 "1, 3 승인"이 앞서 보여 준 다른 목록이 아니라 그 목록의 항목을 가리킨다.

export type ListKind = "candidates" | "review";

const shown = new Map<string, { kind: ListKind; ids: string[] }>();
const MAX = 100;   // 기억하는 대화 수

export function setShown(conversation: string | undefined, kind: ListKind, ids: string[]): void {
  const key = conversation ?? "default";
  shown.delete(key);
  shown.set(key, { kind, ids });
  // 넘치면 가장 오래된 것부터 버린다.
  for (const old of shown.keys()) {
    if (shown.size <= MAX) break;
    shown.delete(old);
  }
}

// 마지막 목록이 이 종류일 때만 id들을 돌려준다.
export function lastShown(conversation: string | undefined, kind: ListKind): string[] | undefined {
  const found = shown.get(conversation ?? "default");
  return found?.kind === kind ? found.ids : undefined;
}

// "1, 3 승인", "모두 반려", "2번 반려 중복이라서" → 번호, 결정, 나머지(반려 사유).
const REPLY = /^(모두|전부|[\d\s,번]+?)\s*(승인|반려)\s*(?:해\s*줘|해|합니다)?[.!]?\s*(.*)$/;

export function parseDecision(text: string): { which: string; decision: "approved" | "rejected"; reason: string } | undefined {
  const match = REPLY.exec(text.trim());
  if (!match) return undefined;
  return { which: match[1].trim(), decision: match[2] === "승인" ? "approved" : "rejected", reason: match[3].trim() };
}

// 번호가 가리키는 id들. "모두"/"전부"는 목록 전체.
export function pick(which: string, order: string[]): string[] {
  if (/^(모두|전부)$/.test(which)) return order;
  return which.split(/[\s,번]+/)
    .filter(Boolean)
    .map(part => order[Number(part) - 1])
    .filter((id): id is string => !!id);
}
