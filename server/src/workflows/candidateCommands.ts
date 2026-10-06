import { approvedSize, decideCandidates, pendingCandidates, type Candidate } from "../knowledge/candidateStore.js";

// Palette commands for knowledge candidates, answered by the service without an AI:
//   /후보                 list the pending candidates with numbers
//   1, 3 승인 / 2 반려    right after a list, decide by number ("모두 승인" for all)
//   /후보 승인 1, 3       the same at any time
// The numbers refer to the last list shown in this conversation.
const shown = new Map<string, string[]>();
const APPROVED_WARN_CHARS = 2500;

const LIST = /^\/후보\s*$/;
const DIRECT = /^\/후보\s+(승인|반려)\s+(.+)$/;
const REPLY = /^(모두|전부|[\d\s,번]+)\s*(승인|반려)\s*(해\s*줘|해|합니다)?[.!]?$/;

export async function candidateCommand(question: string, conversation?: string): Promise<string | undefined> {
  const key = conversation ?? "default";
  if (LIST.test(question)) {
    const pending = await pendingCandidates();
    shown.set(key, pending.map(item => item.id));
    return listText(pending);
  }
  const direct = DIRECT.exec(question);
  const reply = direct ? undefined : shown.has(key) ? REPLY.exec(question) : null;
  if (!direct && !reply) return undefined;
  const decision = (direct?.[1] ?? reply![2]) === "승인" ? "approved" : "rejected";
  const which = (direct?.[2] ?? reply![1]).trim();
  const order = shown.get(key) ?? (await pendingCandidates()).map(item => item.id);
  const ids = /^(모두|전부)$/.test(which) ? order
    : which.split(/[\s,번]+/).filter(Boolean).map(part => order[Number(part) - 1]).filter((id): id is string => !!id);
  if (!ids.length) return "번호를 찾지 못했습니다. /후보로 목록을 다시 보고 \"1, 3 승인\"처럼 답해 주세요.";

  const decided = await decideCandidates(ids, decision);
  const rest = await pendingCandidates();
  shown.set(key, rest.map(item => item.id));
  const size = decision === "approved" ? await approvedSize() : 0;
  return [
    decision === "approved"
      ? `${decided.length}개를 승인해 공통 규칙(승인된_지식)에 넣었습니다. 다음 질문부터 적용됩니다.`
      : `${decided.length}개를 반려했습니다. AI에게 전달되지 않습니다.`,
    "",
    ...decided.map(item => `- ${item.content}`),
    ...(size > APPROVED_WARN_CHARS ? ["", `승인된 지식이 ${size}자로 길어져 매 질문의 비용이 늘어납니다. 필요 없는 줄은 data\\knowledge\\rules\\승인된_지식.md에서 지워 주세요.`] : []),
    "",
    rest.length ? `남은 후보 ${rest.length}개는 /후보로 볼 수 있습니다.` : "남은 후보가 없습니다."
  ].join("\n");
}

function listText(pending: Candidate[]): string {
  if (!pending.length) return "검토할 지식 후보가 없습니다. 대화 중에 사용자가 말한 일반적인 작업 관행이 후보로 모입니다.";
  return [
    `### 지식 후보 ${pending.length}개`,
    "승인하면 공통 규칙에 들어가 모든 도면의 질문에 적용됩니다.",
    "",
    ...pending.map((item, index) => `${index + 1}. **${item.content}**\n   - 근거: ${item.evidence || "없음"} (${item.drawing}, ${item.at.slice(0, 10)}, ${item.provider})`),
    "",
    "\"1, 3 승인\"이나 \"2 반려\"처럼 답해 주세요. 모두 승인하려면 \"모두 승인\"이라고 하시면 됩니다."
  ].join("\n");
}
