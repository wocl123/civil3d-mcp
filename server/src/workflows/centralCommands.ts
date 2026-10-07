// 중앙 서버 팔레트 명령. AI 없이 서비스가 바로 답한다 (docs/데이터관리_설계.md §9).
//   /중앙                         상태
//   /중앙 연결 <주소> <가입키> <인증서지문>   이 PC 등록 (https 주소면 지문 필수. 중앙 서버 시작 화면에 나온다)
//   /중앙 주소 <주소> [인증서지문]           서버가 옮겨 감: 주소만 바꾸고 등록은 그대로
//   /중앙 끊기, /중앙 켜기         보내기 멈춤 / 다시 시작 (기록은 계속 쌓인다)
//   /중앙 검토자 <키>             이 PC를 검토자로
//   /중앙 동기화                  지금 바로 동기화
//   /검토, 이어서 "1 승인" / "2 반려 사유", /검토 보고    검토자 전용
//   /설정값                       지금 적용되는 설정값과 출처

import { install } from "../data/install.js";
import { centralUrl, insecureUrl, loadSettings, saveSettings } from "../data/settings.js";
import { PARAMETERS, isParameterKey, parameterSummary } from "../knowledge/parameters.js";
import { CentralError, decide, enroll, getOfficial, normalizeFingerprint, getReport, getReview, type ReviewItem } from "../sync/centralClient.js";
import { runSync, syncStatus } from "../sync/syncLoop.js";
import { lastShown, parseDecision, pick, setShown } from "./shownLists.js";

const HTTP_WARNING = "주의: 암호화되지 않은 http 주소입니다. 인터넷을 거친다면 https 주소를 쓰세요.";

// 이 명령들 중 하나면 답 글을, 아니면 undefined(→ 다음 명령 처리기나 AI로).
export async function centralCommand(question: string, conversation?: string): Promise<string | undefined> {
  const text = question.trim();
  if (text === "/설정값") return parametersText();
  if (/^\/중앙(\s|$)/.test(text)) return central(text.replace(/^\/중앙\s*/, ""));
  if (text === "/검토") return reviewList(conversation);
  if (text === "/검토 보고") return report();

  // "1 승인" 같은 답은 마지막 목록이 검토 목록일 때만 받는다.
  const listed = lastShown(conversation, "review");
  const reply = listed ? parseDecision(text) : undefined;
  return reply && listed ? reviewDecide(reply, listed, conversation) : undefined;
}

// 실패 메시지: 중앙 서버 오류는 그대로, 그 밖은 "오류: ...".
const failure = (error: unknown) =>
  error instanceof CentralError ? error.message : `오류: ${error instanceof Error ? error.message : String(error)}`;

// /중앙 ... 처리.
async function central(rest: string): Promise<string> {
  const settings = await loadSettings();
  const [command, ...args] = rest.split(/\s+/).filter(Boolean);
  if (!command) return statusText();

  // ── 연결: 가입키로 등록하고 토큰을 저장한다(가입키는 저장하지 않는다).
  if (command === "연결") {
    const url = centralUrl(args[0] ?? "");
    const pin = args[2] ? normalizeFingerprint(args[2]) : undefined;
    if (!url || !args[1] || (url.startsWith("https:") && !pin))
      return "형식: /중앙 연결 <주소> <가입키> <인증서지문>\n예: /중앙 연결 https://192.168.0.10:48950 가입키 3fa1…(64자)\n주소·가입키·지문은 중앙 서버 시작 화면에 나옵니다.";
    try {
      const { token } = await enroll(url, (await install()).installId, args[1], pin);
      // 같은 서버에 다시 연결하면 검토자 키는 유지한다.
      const keepReviewer = settings.central?.url === url && settings.central.reviewerKey
        ? { reviewerKey: settings.central.reviewerKey } : {};
      settings.central = { url, token, ...(pin ? { certSha256: pin } : {}), enabled: true, enrolledAt: new Date().toISOString(), ...keepReviewer };
      await saveSettings(settings);
      void runSync();
      return [
        `중앙 서버 ${url}에 연결했습니다. 쌓인 기록과 지식 후보를 곧 보내고 중앙 지식을 받습니다.`,
        ...(insecureUrl(url) ? ["", HTTP_WARNING] : [])
      ].join("\n");
    } catch (error) {
      return `연결하지 못했습니다. ${failure(error)}`;
    }
  }

  if (!settings.central) return "중앙 서버에 연결되어 있지 않습니다. /중앙 연결 <주소> <가입키>로 연결해 주세요.";

  // ── 주소: 서버가 데이터째 옮겨 갔다(다른 PC, 새 IP). 토큰은 그대로, 주소만 바꾼다.
  //    새 주소에서 이 PC의 등록이 확인될 때만 바꾼다.
  if (command === "주소") {
    const url = centralUrl(args[0] ?? "");
    if (!url) return "형식: /중앙 주소 <새 주소> [인증서지문]\n예: /중앙 주소 https://192.168.0.25:48950 (서버 인증서가 바뀌었으면 지문도)";
    const moved = { ...settings.central, url, ...(args[1] ? { certSha256: normalizeFingerprint(args[1]) } : {}) };
    try {
      await getOfficial(moved, -1);
    } catch (error) {
      return `새 주소에서 이 PC를 확인하지 못했습니다. 주소는 바꾸지 않았습니다. ${failure(error)}\n` +
        "서버 데이터를 옮기지 않았다면 /중앙 연결 <주소> <가입키>로 새로 연결해 주세요.";
    }
    settings.central = moved;
    await saveSettings(settings);
    void runSync();
    return [`중앙 서버 주소를 ${url}(으)로 바꿨습니다. 등록은 그대로입니다.`, ...(insecureUrl(url) ? ["", HTTP_WARNING] : [])].join("\n");
  }

  // ── 끊기 / 켜기
  if (command === "끊기") {
    settings.central.enabled = false;
    await saveSettings(settings);
    return "중앙 서버로 보내기를 멈췄습니다. 기록은 이 PC에 계속 쌓이고, /중앙 켜기로 다시 보낼 수 있습니다.";
  }
  if (command === "켜기") {
    settings.central.enabled = true;
    await saveSettings(settings);
    void runSync();
    return "중앙 서버로 보내기를 다시 시작했습니다.";
  }

  // ── 검토자: 키가 맞는지 서버에서 확인한 뒤 저장한다.
  if (command === "검토자") {
    if (!args[0]) return "형식: /중앙 검토자 <검토자 키>";
    const candidate = { ...settings.central, reviewerKey: args[0] };
    try {
      await getReview(candidate);
    } catch (error) {
      return `검토자 키를 확인하지 못했습니다. ${failure(error)}`;
    }
    settings.central = candidate;
    await saveSettings(settings);
    return "이 PC를 검토자로 설정했습니다. /검토로 후보와 통계 제안을 볼 수 있습니다.";
  }

  // ── 동기화
  if (command === "동기화") {
    const result = await runSync();
    return result.error
      ? `동기화 중 문제가 있었습니다. ${result.error}`
      : `동기화했습니다. 보낸 묶음 ${result.sent}개, 보낸 후보 ${result.candidates}개, 중앙 지식 v${result.official ?? "?"}.`;
  }

  return "알 수 없는 명령입니다. /중앙, /중앙 연결, /중앙 주소, /중앙 끊기, /중앙 켜기, /중앙 검토자, /중앙 동기화를 쓸 수 있습니다.";
}

// /중앙 : 연결 상태, 익명 ID, 대기·막힌 묶음, 마지막 보냄·받음, 보내는 것/안 보내는 것.
async function statusText(): Promise<string> {
  const [settings, { installId }, { state, pending, blocked }] = await Promise.all([loadSettings(), install(), syncStatus()]);
  const central = settings.central;
  const when = (iso?: string) => iso ? new Date(iso).toLocaleString("ko-KR") : "없음";
  const connection = central
    ? `${central.url} (${central.enabled ? "보내는 중" : "멈춤"}${central.reviewerKey ? ", 검토자" : ""})`
    : "연결 안 됨";

  return [
    "### 중앙 서버",
    `- 연결: ${connection}`,
    `- 익명 설치 ID: ${installId}`,
    `- 보낼 묶음 ${pending}개, 검사에서 막힌 묶음 ${blocked}개${blocked ? " (data\\outbox\\blocked에 사유가 있습니다)" : ""}`,
    `- 마지막 보냄 ${when(state.lastPush)}, 마지막 받음 ${when(state.lastPull)}, 중앙 지식 v${state.officialVersion ?? 0}`,
    ...(state.lastError ? [`- 마지막 문제: ${state.lastError}`] : []),
    "",
    "보내는 것: 질문 종류·도구·시간·토큰·실패 종류, 도면 변경 결과, AI가 만든 값을 사람이 고쳤는지, 지식 후보.",
    "보내지 않는 것: 질문·답변 원문, 도면 이름·경로·좌표·핸들, 사용자·PC 이름."
  ].join("\n");
}

// /설정값
async function parametersText(): Promise<string> {
  const list = await parameterSummary();
  return [
    "### 설정값",
    "승인된 관행 중 코드가 직접 쓰는 값입니다. 이 PC 승인 > 중앙 승인 > 기본값 순서입니다.",
    "",
    ...list.map(item => `- ${item.label}: **${item.value}** (${item.source})`)
  ].join("\n");
}

const supportText = (item: ReviewItem) => `${item.support.installs}개 설치 · ${item.support.cases}건`;
const parameterLabel = (parameter?: { key: string; value: number }) =>
  parameter && isParameterKey(parameter.key) ? `${PARAMETERS[parameter.key].label} = ${parameter.value}` : undefined;

// 검토자 PC면 연결 설정, 아니면 undefined.
async function reviewer() {
  const central = (await loadSettings()).central;
  return central?.reviewerKey ? central : undefined;
}

// /검토 : 후보 묶음과 통계 제안을 번호와 함께.
async function reviewList(conversation?: string): Promise<string> {
  const central = await reviewer();
  if (!central) return "검토자 PC가 아닙니다. /중앙 검토자 <키>로 설정해 주세요.";
  try {
    const { items, official } = await getReview(central);
    setShown(conversation, "review", items.map(item => item.id));
    if (!items.length) return `검토할 항목이 없습니다. 지금 중앙 지식은 v${official.version}, ${official.items.length}개입니다.`;

    return [
      `### 검토할 항목 ${items.length}개 (중앙 지식 v${official.version})`,
      "승인하면 모든 PC가 다음 동기화(10분 이내)에서 받습니다.",
      "",
      ...items.map((item, index) => [
        `${index + 1}. ${item.kind === "parameter" ? "[통계 제안] " : ""}**${item.content}**`,
        ...(parameterLabel(item.parameter) ? [`   - 설정값: ${parameterLabel(item.parameter)}`] : []),
        `   - 지지: ${supportText(item)}`,
        ...item.evidence.slice(0, 3).map(line => `   - ${line}`)
      ].join("\n")),
      "",
      "\"1 승인\", \"2 반려 사유\"처럼 답해 주세요. 반려에는 사유가 필요합니다."
    ].join("\n");
  } catch (error) {
    return `검토 목록을 받지 못했습니다. ${failure(error)}`;
  }
}

// "1 승인" / "2 반려 사유" 처리. 반려에는 사유가 필요하다.
async function reviewDecide(reply: NonNullable<ReturnType<typeof parseDecision>>, listed: string[],
  conversation?: string): Promise<string> {
  const central = await reviewer();
  if (!central) return "검토자 PC가 아닙니다.";
  const ids = pick(reply.which, listed);
  if (!ids.length) return "번호를 찾지 못했습니다. /검토로 목록을 다시 봐 주세요.";
  if (reply.decision === "rejected" && !reply.reason) return "반려 사유를 함께 적어 주세요. 예: \"2 반려 회사마다 달라서\"";

  const lines: string[] = [];
  let version: number | undefined;
  for (const id of ids) {
    try {
      const done = await decide(central, {
        id,
        decision: reply.decision === "approved" ? "approve" : "reject",
        ...(reply.reason ? { reason: reply.reason } : {})
      });
      version = done.version;
      lines.push(`- ${done.decided}`);
    } catch (error) {
      lines.push(`- ${id}: ${failure(error)}`);
    }
  }

  // 결정한 항목은 목록에서 뺀다(남은 번호로 이어서 답할 수 있게). 승인했으면 바로 동기화해 받는다.
  setShown(conversation, "review", listed.filter(id => !ids.includes(id)));
  if (reply.decision === "approved") void runSync();

  const head = `${reply.decision === "approved" ? "승인" : "반려"}했습니다${version !== undefined ? ` (중앙 지식 v${version})` : ""}.`;
  return [head, "", ...lines].join("\n");
}

// /검토 보고 : 최근 기간의 실패·도구 통계와 수정 추적 결과.
async function report(): Promise<string> {
  const central = await reviewer();
  if (!central) return "검토자 PC가 아닙니다.";
  try {
    const data = await getReport(central) as {
      days: number;
      installs: number;
      turns: number;
      failedTurns: Record<string, number>;
      tools: { tool: string; calls: number; failed: number; avgMs: number }[];
      kept: Record<string, Record<string, number>>;
    };
    return [
      `### 최근 ${data.days}일 보고 (설치 ${data.installs}곳, 질문 ${data.turns}건)`,
      "",
      "**실패한 질문**",
      ...Object.entries(data.failedTurns).map(([kind, n]) => `- ${kind}: ${n}건`),
      "",
      "**도구** (호출 · 실패 · 평균 시간)",
      ...data.tools.map(item => `- ${item.tool}: ${item.calls} · ${item.failed} · ${item.avgMs} ms`),
      "",
      "**AI가 만든 값을 사람이 어떻게 했나**",
      ...Object.entries(data.kept).map(([property, outcomes]) =>
        `- ${property}: ${Object.entries(outcomes).map(([outcome, n]) => `${outcome} ${n}`).join(", ")}`)
    ].join("\n");
  } catch (error) {
    return `보고를 받지 못했습니다. ${failure(error)}`;
  }
}
