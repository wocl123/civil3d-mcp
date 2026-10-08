// PC 밖으로 나가기 직전의 마지막 검사와, 자유 글 가리기.
// 보내는 기록은 처음부터 허용한 항목만으로 만든다(records.ts). 여기서는 그래도 빠져나간 것을 잡는다.
// 관리자 PC도 가져올 때 같은 규칙으로 다시 검사한다(admin/validate.ts).

// [찾는 모양, 이유]
const PATTERNS: [RegExp, string][] = [
  [/[A-Za-z]:[\\/]/, "드라이브 경로"],
  [/\\\\[\w.-]+\\/, "네트워크 경로"],
  [/[\w.+-]+@[\w-]+\.[\w.-]+/, "메일 주소"],
  [/[^\s"'\\/]+\.(dwg|dxf|dwt|rvt|pdf|xlsx?)\b/i, "파일 이름"],
  [/\b(sk|pk|ghp|gho)[-_][A-Za-z\d]{16,}/, "키 형태의 문자열"]
];

// 정규식 특수 문자를 글자 그대로 찾도록 바꾼다.
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// 가릴 낱말 하나를 찾는 정규식.
//   한글 낱말: 조사가 붙으므로("부산신항에서") 어디서든 찾는다.
//   영문·숫자: 낱말 전체로만 찾는다("SITE"가 "composite" 안에서 걸리지 않게).
const termPattern = (term: string) => /[가-힣]/.test(term)
  ? new RegExp(escape(term), "giu")
  : new RegExp(`(?<![\\p{L}\\p{N}])${escape(term)}(?![\\p{L}\\p{N}])`, "giu");

// 이 글이 PC 밖으로 나가면 안 되는 이유. 괜찮으면 undefined.
export function leak(text: string, terms: string[]): string | undefined {
  for (const [pattern, reason] of PATTERNS) if (pattern.test(text)) return reason;
  const term = terms.find(item => termPattern(item).test(text));
  return term ? `가릴 낱말(${term.length}자)` : undefined;
}

// 자유 글(질문·답, 지식 후보, 도구 입력)에서 경로·파일·메일·키·가릴 낱말을 <경로>, <파일>, <메일>, <키>, <이름>으로 바꾼다.
// 가릴 낱말: 도면 이름, Windows 사용자 이름, PC 이름(data/terms.ts).
export function blank(text: string, terms: string[]): string {
  let out = text
    .replace(/[A-Za-z]:[\\/][^\s"']*/g, "<경로>")
    .replace(/\\\\[\w.-]+\\[^\s"']*/g, "<경로>")
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "<메일>")
    .replace(/[^\s"'\\/]+\.(dwg|dxf|dwt|rvt|pdf|xlsx?)\b/gi, "<파일>")
    .replace(/\b(sk|pk|ghp|gho)[-_][A-Za-z\d]{16,}/g, "<키>");
  for (const term of terms) out = out.replace(termPattern(term), "<이름>");
  return out;
}

// 시각은 시간 단위까지만: "2026-10-06T13". 분·초까지 있으면 기록과 사람을 맞춰 볼 수 있다.
export const hour = (iso: string) => iso.slice(0, 13);
