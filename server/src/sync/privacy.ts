// The last check before anything leaves this PC, and the blanking of free text.
// Records are built from allowed fields only (records.ts); this catches what slips
// through anyway. The central server runs the same patterns again (central/src/gate.ts).
const PATTERNS: [RegExp, string][] = [
  [/[A-Za-z]:[\\/]/, "드라이브 경로"],
  [/\\\\[\w.-]+\\/, "네트워크 경로"],
  [/[\w.+-]+@[\w-]+\.[\w.-]+/, "메일 주소"],
  [/[^\s"'\\/]+\.(dwg|dxf|dwt|rvt|pdf|xlsx?)\b/i, "파일 이름"],
  [/\b(sk|pk|ghp|gho)[-_][A-Za-z\d]{16,}/, "키 형태의 문자열"]
];

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// A private word as a pattern. Korean words take particles ("부산신항에서"), so they match
// anywhere; Latin words and numbers only as whole words, so "SITE" does not match "composite".
const termPattern = (term: string) => /[가-힣]/.test(term)
  ? new RegExp(escape(term), "giu")
  : new RegExp(`(?<![\\p{L}\\p{N}])${escape(term)}(?![\\p{L}\\p{N}])`, "giu");

// The reason a text may not leave this PC, or undefined when it may.
export function leak(text: string, terms: string[]): string | undefined {
  for (const [pattern, reason] of PATTERNS) if (pattern.test(text)) return reason;
  const term = terms.find(item => termPattern(item).test(text));
  return term ? `가릴 낱말(${term.length}자)` : undefined;
}

// Free text (a knowledge candidate) with paths, files, mail addresses, and private words blanked.
export function blank(text: string, terms: string[]): string {
  let out = text
    .replace(/[A-Za-z]:[\\/][^\s"']*/g, "<경로>")
    .replace(/\\\\[\w.-]+\\[^\s"']*/g, "<경로>")
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "<메일>")
    .replace(/[^\s"'\\/]+\.(dwg|dxf|dwt|rvt|pdf|xlsx?)\b/gi, "<파일>");
  for (const term of terms) out = out.replace(termPattern(term), "<이름>");
  return out;
}

// Hours are enough to see patterns over a day; minutes and seconds could match a person to a record.
export const hour = (iso: string) => iso.slice(0, 13);
