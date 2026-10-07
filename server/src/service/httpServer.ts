import { fixesFor } from "../changes/changeStore.js";
import { cancelFix, fixCard, operationStatus } from "../changes/operations.js";
import { applyFix, confirmOperation, undoOperation } from "../changes/applyChange.js";
import { conversationProvider, offeredFixes, remember } from "../workflows/conversation.js";
import { randomUUID } from "node:crypto";
// 로컬 서비스 (127.0.0.1:48900). Civil 3D 플러그인이 띄우고, 팔레트가 이 HTTP API를 부른다.
//
// API (모두 플러그인 세션 토큰이 필요하다):
//   GET  /api/providers              AI별 상태와 남은 세션 시간
//   GET  /api/version                프로그램 버전과 자동 업데이트 상태, 검토자면 가입 신청 수(팔레트 아래 줄)
//   POST /api/update/check           지금 새 버전 확인
//   POST /api/feedback               답이 이상하다고 표시(팔레트 👎): { requestId, reason? }
//   GET  /api/usage?provider=        서비스가 켜진 뒤 토큰 합계
//   GET  /api/quota?provider=        계정의 남은 사용 한도
//   GET  /api/drawing                도면 상태와 객체 일부(점검용)
//   POST /api/provider/check         로그인 확인(세션 시작)
//   POST /api/provider/setup         AI CLI 설치·로그인 창 열기
//   POST /api/chat, /api/chat/stream 팔레트 질문 (stream은 진행 상황을 한 줄씩 보냄)
//   POST /api/change/apply, /api/change/undo, /api/change/cancel, /api/change/confirm 수정안 버튼 (AI 호출 없음)
//   POST /api/chat/cancel             AI 실행 중지 및 작업 결과 확인
//   POST /api/conversation/clear     대화 지우기
//   POST /api/memory/clear           답변 재사용 저장소 지우기
//   POST /api/shutdown               새 서비스가 자리를 넘겨 달라고 할 때
//
// 수명: 자기를 띄운 Civil 3D가 꺼지면 스스로 끝나고, 포트에 남은 옛 서비스는 넘겨받는다(아래 참고).

import { paletteMessage } from "../errors/failureGuide.js";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { timingSafeEqual } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { callPlugin } from "../bridge/pluginClient.js";
import { getProviderState, isProvider, PROVIDERS, sessionInfo, touchProvider, verifyProvider } from "../ai/aiCli.js";
import { getUsageTotals } from "../ai/usage.js";
import { openSetupWindow } from "../ai/cliSetup.js";
import { getQuota } from "../ai/quota.js";
import { answerChat } from "../workflows/paletteChat.js";
import { clearMemory } from "../memory/memoryStore.js";
import { forget, isConversationId } from "../workflows/conversation.js";
import { pendingJoinRequests, startSyncLoop, syncSoon } from "../sync/syncLoop.js";
import { logFeedback } from "../logs/workLog.js";
import { checkForUpdate, startUpdateLoop, updateState } from "../update/autoUpdate.js";

const host = "127.0.0.1";
const configuredPort = Number(process.env.MY_CIVIL3D_SERVICE_PORT ?? "48900");
if (!Number.isInteger(configuredPort) || configuredPort < 1 || configuredPort > 65535)
  throw new Error("MY_CIVIL3D_SERVICE_PORT must be between 1 and 65535.");
const port = configuredPort;

const MAX_BODY = 16 * 1024;
const activeChats = new Map<string, AbortController>();
const busyChanges = new Set<string>();

// 플러그인 연결 파일(토큰이 들어 있다).
const connectionPath = () => process.env.MY_CIVIL3D_CONNECTION_FILE ??
  join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "MyCivil3DMcp", "connection.json");

// 요청 헤더의 토큰이 플러그인 세션 토큰과 같은지(시간이 일정한 비교).
async function authorized(request: IncomingMessage): Promise<boolean> {
  try {
    const config = JSON.parse(await readFile(connectionPath(), "utf8")) as { token?: string };
    const candidate = request.headers["x-my-civil3d-token"];
    const validCandidate = typeof candidate === "string" && /^[a-f\d]{64}$/i.test(candidate);
    const validToken = typeof config.token === "string" && /^[a-f\d]{64}$/i.test(config.token);
    if (!validCandidate || !validToken) return false;
    return timingSafeEqual(Buffer.from(candidate, "hex"), Buffer.from(config.token!, "hex"));
  } catch {
    return false;
  }
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  response.end(JSON.stringify(body));
}

// 요청 본문(JSON 객체, 16 KB까지).
async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += data.length;
    if (size > MAX_BODY) throw new Error("Request body is too large.");
    chunks.push(data);
  }
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("Request body must be a JSON object.");
  return parsed as Record<string, unknown>;
}

export const httpServer = createServer(async (request, response) => {
  try {
    // ── 보안 검사: 이 주소로 온 요청인지, 세션 토큰이 맞는지, POST는 JSON이고 다른 사이트에서 온 것이 아닌지.
    if (request.headers.host !== `${host}:${port}`) return json(response, 403, { error: "Invalid host." });
    if (!(await authorized(request))) return json(response, 403, { error: "Civil 3D session is not authorized." });

    const url = new URL(request.url ?? "/", `http://${host}:${port}`);
    if (request.method === "POST") {
      const origin = request.headers.origin;
      if (origin && origin !== `http://${host}:${port}`) return json(response, 403, { error: "Cross-origin requests are blocked." });
      if (!request.headers["content-type"]?.startsWith("application/json")) return json(response, 415, { error: "Use application/json." });
    }
    const route = `${request.method} ${url.pathname}`;

    // ── AI 상태
    // joins: 검토자 PC에서 대기 중인 가입 신청 수(팔레트 아래 줄에 "가입 신청 n")
    if (route === "GET /api/version") return json(response, 200, { ...updateState(), joins: pendingJoinRequests() });
    if (route === "POST /api/update/check") return json(response, 200, await checkForUpdate());
    if (route === "POST /api/feedback") {
      const input = await body(request) as { requestId?: unknown; reason?: unknown; rating?: unknown };
      if (typeof input.requestId !== "string" || !/^[\w-]{8,64}$/.test(input.requestId)) return json(response, 400, { error: "답을 찾을 수 없습니다." });
      const reason = typeof input.reason === "string" ? input.reason.trim().slice(0, 500) : "";
      await logFeedback({ requestId: input.requestId, rating: input.rating === "good" ? "good" : "bad", ...(reason ? { reason } : {}) });
      syncSoon();
      return json(response, 200, { recorded: true });
    }

    if (route === "GET /api/providers") {
      const states = await Promise.all(PROVIDERS.map(async provider => ({
        provider, state: await getProviderState(provider), session: sessionInfo(provider)
      })));
      return json(response, 200, { providers: states });
    }

    if (route === "GET /api/usage") {
      const provider = url.searchParams.get("provider");
      if (!isProvider(provider)) return json(response, 400, { error: "Unknown AI provider." });
      return json(response, 200, { provider, totals: getUsageTotals(provider) });
    }

    if (route === "GET /api/quota") {
      const provider = url.searchParams.get("provider");
      if (!isProvider(provider)) return json(response, 400, { error: "Unknown AI provider." });
      const quota = await getQuota(provider, url.searchParams.get("refresh") === "1");
      return json(response, 200, { provider, quota });
    }

    // ── 도면 (점검용)
    if (route === "GET /api/drawing") {
      const status = await callPlugin("drawing.status");
      const objects = await callPlugin("drawing.objects", { offset: 0, limit: 40 });
      return json(response, 200, { status, objects });
    }

    // ── 로그인 확인 / 설치·로그인 창
    if (route === "POST /api/provider/check") {
      const input = await body(request);
      if (!isProvider(input.provider)) return json(response, 400, { error: "Unknown AI provider." });
      const state = await verifyProvider(input.provider);
      return json(response, 200, { provider: input.provider, state, session: sessionInfo(input.provider) });
    }

    if (route === "POST /api/provider/setup") {
      const input = await body(request);
      if (!isProvider(input.provider) || (input.action !== "install" && input.action !== "login"))
        return json(response, 400, { error: "provider와 action(install, login)이 필요합니다." });
      return json(response, 200, await openSetupWindow(input.provider, input.action));
    }

    // 버튼 작업은 AI를 다시 호출하지 않는다. 대화에서 제안된 수정안만 직접 적용한다.
    if (route === "POST /api/change/apply" || route === "POST /api/change/undo" || route === "POST /api/change/status" || route === "POST /api/change/cancel" || route === "POST /api/change/confirm") {
      const input = await body(request);
      if (!isConversationId(input.conversation)) return json(response, 400, { error: "대화 ID가 필요합니다." });
      const conversation = input.conversation;
      if (activeChats.has(conversation) || busyChanges.has(conversation)) return json(response, 409, { error: "진행 중인 작업이 끝난 뒤 눌러 주세요." });
      busyChanges.add(conversation);
      try {
        const offered = offeredFixes(conversation, Number.MAX_SAFE_INTEGER);
        if (route.endsWith("/status")) {
          if (typeof input.fixId !== "string") return json(response, 400, { error: "수정안 ID가 필요합니다." });
          return json(response, 200, await operationStatus(input.fixId, offered));
        }
        if (route.endsWith("/confirm")) {
          if (typeof input.operationId !== "string") return json(response, 400, { error: "작업 ID가 필요합니다." });
          const result = await confirmOperation(input.operationId, offered);
          remember(conversation, { provider: conversationProvider(conversation), question: "[적용 버튼]", answer: `${result.title}: 확정함. 버튼으로 되돌릴 수 없음`, fixIds: [result.fixId] });
          return json(response, 200, result);
        }
        if (route.endsWith("/cancel")) {
          if (typeof input.fixId !== "string") return json(response, 400, { error: "수정안 ID가 필요합니다." });
          await cancelFix(input.fixId, offered);
          remember(conversation, { provider: conversationProvider(conversation), question: "[취소 버튼]", answer: `${input.fixId}: 사용자가 취소함. 적용하지 않음`, fixIds: [] });
          return json(response, 200, { state: "cancelled", message: "취소했습니다. 도면은 바뀌지 않았습니다." });
        }
        if (route.endsWith("/undo")) {
          if (typeof input.operationId !== "string") return json(response, 400, { error: "작업 ID가 필요합니다." });
          const result = await undoOperation(input.operationId, offered);
          remember(conversation, { provider: conversationProvider(conversation), question: "[되돌리기 버튼]", answer: `${result.title}: 되돌림`, fixIds: [result.fixId] });
          return json(response, 200, result);
        }
        if (typeof input.fixId !== "string") return json(response, 400, { error: "수정안 ID가 필요합니다." });
        const requestId = randomUUID();
        const result = await applyFix(input.fixId, offered, requestId, typeof input.operationId === "string" ? input.operationId : undefined);
        // 제안 카드 읽기 실패가 이미 커밋한 변경을 HTTP 실패로 바꾸지 않게 한다.
        const fixes = await fixesFor(requestId).catch(() => []);
        remember(conversation, { provider: conversationProvider(conversation), question: "[적용하기 버튼]", answer: JSON.stringify(result), fixIds: [input.fixId, ...fixes.map(fix => fix.id)] });
        return json(response, 200, { ...result, fixes: fixes.map(fixCard) });
      } finally { busyChanges.delete(conversation); }
    }
    if (route === "POST /api/chat/cancel") {
      const input = await body(request);
      if (isConversationId(input.conversation)) activeChats.get(input.conversation)?.abort();
      return json(response, 200, { cancelling: true });
    }

    // ── 팔레트 질문
    if (route === "POST /api/chat" || route === "POST /api/chat/stream") {
      const input = await body(request);
      if (!isProvider(input.provider) || typeof input.message !== "string" ||
          input.message.trim().length < 1 || input.message.length > 4000)
        return json(response, 400, { error: "AI를 고르고 4000자 이내로 질문을 입력해 주세요." });

      const state = await getProviderState(input.provider);
      if (state !== "ready") {
        return json(response, 403, {
          error: state === "unchecked"
            ? "AI 세션 시간이 지나 사용이 풀렸습니다. 위에서 AI를 다시 눌러 주세요."
            : "선택한 AI가 설치되어 있지 않거나 로그인이 확인되지 않았습니다."
        });
      }

      // 질문은 세션을 살린다: 지금, 그리고 답이 끝날 때 시간을 다시 시작한다.
      touchProvider(input.provider);
      const conversation = isConversationId(input.conversation) ? input.conversation : undefined;

      const chatKey = conversation ?? "anonymous";
      if (activeChats.has(chatKey) || busyChanges.has(chatKey)) return json(response, 409, { error: "이미 이 대화의 작업이 진행 중입니다." });
      const controller = new AbortController();
      activeChats.set(chatKey, controller);
      const disconnected = () => { if (!response.writableEnded) controller.abort(); };
      response.once("close", disconnected);
      try {
        // 한 번에 답 전체
        if (url.pathname === "/api/chat") {
          const result = await answerChat(input.provider, input.message, undefined, conversation, controller.signal);
          touchProvider(input.provider);
          return json(response, 200, { ...result, session: sessionInfo(input.provider) });
        }

        // 스트림: 한 줄에 JSON 하나. 진행(progress)·답 조각(delta) 이벤트, 끝에 done(위와 같은 결과) 또는 error.
        response.writeHead(200, {
          "Content-Type": "application/x-ndjson; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff"
        });
        const send = (event: Record<string, unknown>) => response.write(JSON.stringify(event) + "\n");
        try {
          const result = await answerChat(input.provider, input.message, event => send(event), conversation, controller.signal);
          touchProvider(input.provider);
          send({ type: "done", ...result, session: sessionInfo(input.provider) });
        } catch (error) {
          send({ type: "error", error: paletteMessage(error instanceof Error ? error.message : String(error)),
            applied: (error as { applied?: unknown }).applied });
        }
        return response.end();
      } finally { activeChats.delete(chatKey); response.off("close", disconnected); }
    }

    // ── 지우기
    if (route === "POST /api/conversation/clear") {
      const input = await body(request);
      if (isConversationId(input.conversation)) forget(input.conversation);
      return json(response, 200, { cleared: true });
    }

    if (route === "POST /api/memory/clear") {
      await clearMemory();
      return json(response, 200, { cleared: true });
    }

    // ── 나중에 켜진 Civil 3D의 새 서비스가 자리를 넘겨 달라고 함
    if (route === "POST /api/shutdown") {
      json(response, 200, { stopping: true });
      process.stderr.write("MyCivil3DMcp local service: replaced by a newer service.\n");
      httpServer.close();
      setTimeout(() => process.exit(0), 200).unref();
      return;
    }

    json(response, 404, { error: "Not found." });
  } catch (error) {
    json(response, 503, { error: paletteMessage(error instanceof Error ? error.message : String(error)), applied: (error as { applied?: unknown }).applied });
  }
});

// 포트를 잡은 뒤: 뒤쪽 작업(수정 추적, 보낼 묶음, 중앙 지식, 정리)을 시작한다. docs/데이터관리_설계.md §8
function started(): void {
  process.stderr.write(`MyCivil3DMcp local service: ${host}:${port}\n`);
  if (process.env.MY_CIVIL3D_SYNC !== "off") startSyncLoop();
  startUpdateLoop();
}

// 수명 ①: 자기를 띄운 Civil 3D가 살아 있는 동안만 산다.
// Civil 3D가 꺼질 때 항상 이 서비스를 끄지는 않는다. 남은 서비스가 다음 Civil 3D에 옛 코드로 답하면 안 된다.
const parent = Number(process.env.MY_CIVIL3D_PARENT_PID);
if (Number.isInteger(parent) && parent > 0) {
  setInterval(() => {
    try {
      process.kill(parent, 0);   // 신호 0: 프로세스가 있는지만 본다
    } catch {
      process.stderr.write("MyCivil3DMcp local service: Civil 3D has exited.\n");
      process.exit(0);
    }
  }, 5000);
}

// 수명 ②: 포트에 남은 서비스(옛 빌드, 또는 Civil 3D가 이미 꺼진 것)에 이 세션 토큰으로 종료를 요청한다.
async function takeOver(): Promise<void> {
  try {
    const { token } = JSON.parse(await readFile(connectionPath(), "utf8")) as { token?: string };
    await fetch(`http://${host}:${port}/api/shutdown`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-my-civil3d-token": token ?? "" },
      body: "{}",
      signal: AbortSignal.timeout(3000)
    });
  } catch {
    // 이미 꺼졌거나, /api/shutdown 을 모르는 옛 서비스다.
  }
}

// 포트가 이미 쓰이면 넘겨받기를 시도하고 1초 뒤 다시 잡는다(최대 5번).
let attempts = 0;
httpServer.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code !== "EADDRINUSE" || ++attempts > 5) {
    process.stderr.write(`MyCivil3DMcp local service could not start: ${error.message}\n` +
      (error.code === "EADDRINUSE" ? `Another program holds port ${port}. Close it, or set MY_CIVIL3D_SERVICE_PORT.\n` : ""));
    process.exit(1);
  }
  void takeOver().then(() => setTimeout(() => httpServer.listen(port, host), 1000));
});

httpServer.listen(port, host, started);
