import { approvedSize, decideCandidates, parameterText, pendingCandidates, type Candidate } from "../knowledge/candidateStore.js";
import { lastShown, parseDecision, pick, setShown } from "./shownLists.js";

// 지식 후보 팔레트 명령. AI 없이 서비스가 바로 답한다.
//   /후보                 대기 중인 후보를 번호와 함께 보여 줌
//   1, 3 승인 / 2 반려    목록 바로 뒤에 번호로 결정 ("모두 승인"은 전부)
//   /후보 승인 1, 3       언제든 같은 일
// 번호는 이 대화에서 마지막으로 보여 준 목록을 가리킨다.

// 승인된 지식이 이 글자 수를 넘으면 매 질문 비용이 늘어난다고 알린다.
const APPROVED_WARN_CHARS = 2500;

const LIST = /^\/후보\s*$/;
const DIRECT = /^\/후보\s+(승인|반려)\s+(.+)$/;

// 후보 명령이면 답 글을, 아니면 undefined(→ AI에게 넘어감).
export async function candidateCommand(question: string, conversation?: string): Promise<string | undefined> {
  if (LIST.test(question)) {
    const pending = await pendingCandidates();
    setShown(conversation, "candidates", pending.map(item => item.id));
    return listText(pending);
  }
  // "/후보 승인 1"은 언제든, "1 승인"은 마지막 목록이 후보 목록일 때만 받는다.
  const direct = DIRECT.exec(question);
  const listed = lastShown(conversation, "candidates");
  const reply = direct ? parseDecision(`${direct[2]} ${direct[1]}`) : listed ? parseDecision(question) : undefined;
  if (!reply) return undefined;
  const order = listed ?? (await pendingCandidates()).map(item => item.id);
  const ids = pick(reply.which, order);
  if (!ids.length) return "번호를 찾지 못했습니다. /후보로 목록을 다시 보고 \"1, 3 승인\"처럼 답해 주세요.";

  const decision = reply.decision;
  const decided = await decideCandidates(ids, decision);
  const rest = await pendingCandidates();
  setShown(conversation, "candidates", rest.map(item => item.id));
  const size = decision === "approved" ? await approvedSize() : 0;
  return [
    decision === "approved"
      ? `${decided.length}개를 승인해 이 PC의 공통 규칙(승인된_지식)에 넣었습니다. 다음 질문부터 적용됩니다.`
      : `${decided.length}개를 반려했습니다. AI에게 전달되지 않고, 아직 중앙에 보내지 않은 것은 보내지 않습니다.`,
    "",
    ...decided.map(item => `- ${item.content}${item.parameter && decision === "approved" ? ` → 설정값 ${parameterText(item.parameter)} 적용` : ""}`),
    ...(size > APPROVED_WARN_CHARS ? ["", `승인된 지식이 ${size}자로 길어져 매 질문의 비용이 늘어납니다. 필요 없는 줄은 승인된_지식.md에서 지워 주세요.`] : []),
    "",
    rest.length ? `남은 후보 ${rest.length}개는 /후보로 볼 수 있습니다.` : "남은 후보가 없습니다."
  ].join("\n");
}

// 후보 목록 글.
function listText(pending: Candidate[]): string {
  if (!pending.length) return "검토할 지식 후보가 없습니다. 대화 중에 사용자가 말한 일반적인 작업 관행이 후보로 모입니다.";
  return [
    `### 지식 후보 ${pending.length}개`,
    "승인하면 이 PC의 공통 규칙에 들어가 모든 도면의 질문에 적용됩니다. 중앙 서버에 연결되어 있으면 검토자에게도 자동으로 올라갑니다.",
    "",
    ...pending.map((item, index) => [
      `${index + 1}. **${item.content}**`,
      ...(item.parameter ? [`   - 승인하면 설정값: ${parameterText(item.parameter)}`] : []),
      `   - 근거: ${item.evidence || "없음"} (${item.drawing}, ${item.at.slice(0, 10)}, ${item.provider}${item.submittedAt ? ", 중앙 제출됨" : ""})`
    ].join("\n")),
    "",
    "\"1, 3 승인\"이나 \"2 반려\"처럼 답해 주세요. 모두 승인하려면 \"모두 승인\"이라고 하시면 됩니다."
  ].join("\n");
}
