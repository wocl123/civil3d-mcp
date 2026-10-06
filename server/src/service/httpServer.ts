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
import { startSyncLoop } from "../sync/syncLoop.js";

const host = "127.0.0.1";
const configuredPort = Number(process.env.MY_CIVIL3D_SERVICE_PORT ?? "48900");
if (!Number.isInteger(configuredPort) || configuredPort < 1 || configuredPort > 65535)
  throw new Error("MY_CIVIL3D_SERVICE_PORT must be between 1 and 65535.");
const port = configuredPort;

async function authorized(request: IncomingMessage): Promise<boolean> {
  const file = process.env.MY_CIVIL3D_CONNECTION_FILE ??
    join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "MyCivil3DMcp", "connection.json");
  try {
    const config = JSON.parse(await readFile(file, "utf8")) as { token?: string };
    const candidate = request.headers["x-my-civil3d-token"];
    if (typeof candidate !== "string" || !/^[a-f\d]{64}$/i.test(candidate) ||
        typeof config.token !== "string" || !/^[a-f\d]{64}$/i.test(config.token)) return false;
    return timingSafeEqual(Buffer.from(candidate, "hex"), Buffer.from(config.token, "hex"));
  } catch { return false; }
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  response.end(JSON.stringify(body));
}

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += data.length;
    if (size > 16 * 1024) throw new Error("Request body is too large.");
    chunks.push(data);
  }
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("Request body must be a JSON object.");
  return parsed as Record<string, unknown>;
}

const httpServer = createServer(async (request, response) => {
  try {
    if (request.headers.host !== `${host}:${port}`)
      return json(response, 403, { error: "Invalid host." });
    if (!(await authorized(request)))
      return json(response, 403, { error: "Civil 3D session is not authorized." });
    const url = new URL(request.url ?? "/", `http://${host}:${port}`);
    if (request.method === "POST") {
      const origin = request.headers.origin;
      if (origin && origin !== `http://${host}:${port}`)
        return json(response, 403, { error: "Cross-origin requests are blocked." });
      if (!request.headers["content-type"]?.startsWith("application/json"))
        return json(response, 415, { error: "Use application/json." });
    }

    if (request.method === "GET" && url.pathname === "/api/providers") {
      const states = await Promise.all(PROVIDERS.map(async provider => ({
        provider, state: await getProviderState(provider), session: sessionInfo(provider)
      })));
      return json(response, 200, { providers: states });
    }
    if (request.method === "GET" && url.pathname === "/api/usage") {
      const provider = url.searchParams.get("provider");
      if (!isProvider(provider)) return json(response, 400, { error: "Unknown AI provider." });
      return json(response, 200, { provider, totals: getUsageTotals(provider) });
    }
    if (request.method === "GET" && url.pathname === "/api/quota") {
      const provider = url.searchParams.get("provider");
      if (!isProvider(provider)) return json(response, 400, { error: "Unknown AI provider." });
      return json(response, 200, {
        provider, quota: await getQuota(provider, url.searchParams.get("refresh") === "1")
      });
    }
    if (request.method === "GET" && url.pathname === "/api/drawing") {
      const status = await callPlugin("drawing.status");
      const objects = await callPlugin("drawing.objects", { offset: 0, limit: 40 });
      return json(response, 200, { status, objects });
    }
    if (request.method === "POST" && url.pathname === "/api/provider/check") {
      const input = await body(request);
      if (!isProvider(input.provider)) return json(response, 400, { error: "Unknown AI provider." });
      const state = await verifyProvider(input.provider);
      return json(response, 200, { provider: input.provider, state, session: sessionInfo(input.provider) });
    }
    // The palette's 설치 창 열기 / 로그인 창 열기: the setup script in a PowerShell window (ai/cliSetup.ts).
    if (request.method === "POST" && url.pathname === "/api/provider/setup") {
      const input = await body(request);
      if (!isProvider(input.provider) || (input.action !== "install" && input.action !== "login"))
        return json(response, 400, { error: "provider와 action(install, login)이 필요합니다." });
      return json(response, 200, await openSetupWindow(input.provider, input.action));
    }
    if (request.method === "POST" && (url.pathname === "/api/chat" || url.pathname === "/api/chat/stream")) {
      const input = await body(request);
      if (!isProvider(input.provider) || typeof input.message !== "string" ||
          input.message.trim().length < 1 || input.message.length > 4000)
        return json(response, 400, { error: "AI를 고르고 4000자 이내로 질문을 입력해 주세요." });
      const state = await getProviderState(input.provider);
      if (state !== "ready")
        return json(response, 403, { error: state === "unchecked"
          ? "AI 세션 시간이 지나 사용이 풀렸습니다. 위에서 AI를 다시 눌러 주세요."
          : "선택한 AI가 설치되어 있지 않거나 로그인이 확인되지 않았습니다." });
      // A question keeps the session alive: its time starts again now and when the answer is done.
      touchProvider(input.provider);

      const conversation = isConversationId(input.conversation) ? input.conversation : undefined;
      if (url.pathname === "/api/chat") {
        const result = await answerChat(input.provider, input.message, undefined, conversation);
        touchProvider(input.provider);
        return json(response, 200, { ...result, session: sessionInfo(input.provider) });
      }
      // One JSON object per line: progress and delta events, then done (the /api/chat result) or error.
      response.writeHead(200, {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff"
      });
      const send = (event: Record<string, unknown>) => response.write(JSON.stringify(event) + "\n");
      try {
        const result = await answerChat(input.provider, input.message, event => send(event), conversation);
        touchProvider(input.provider);
        send({ type: "done", ...result, session: sessionInfo(input.provider) });
      } catch (error) {
        send({ type: "error", error: paletteMessage(error instanceof Error ? error.message : String(error)) });
      }
      return response.end();
    }
    if (request.method === "POST" && url.pathname === "/api/conversation/clear") {
      const input = await body(request);
      if (isConversationId(input.conversation)) forget(input.conversation);
      return json(response, 200, { cleared: true });
    }
    // A newer service (from a Civil 3D started later) asks this one to make room.
    if (request.method === "POST" && url.pathname === "/api/shutdown") {
      json(response, 200, { stopping: true });
      process.stderr.write("MyCivil3DMcp local service: replaced by a newer service.\n");
      httpServer.close();
      setTimeout(() => process.exit(0), 200).unref();
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/memory/clear") {
      await clearMemory();
      return json(response, 200, { cleared: true });
    }
    json(response, 404, { error: "Not found." });
  } catch (error) {
    json(response, 503, { error: paletteMessage(error instanceof Error ? error.message : String(error)) });
  }
});

function started(): void {
  process.stderr.write(`MyCivil3DMcp local service: ${host}:${port}\n`);
  // Tracking checks, outgoing packages, central knowledge, and clean-up (docs/데이터관리_설계.md §8).
  if (process.env.MY_CIVIL3D_SYNC !== "off") startSyncLoop();
}

// The service lives as long as the Civil 3D that started it. Civil 3D does not always stop
// it on exit, and a leftover service would keep answering the next Civil 3D with old code.
const parent = Number(process.env.MY_CIVIL3D_PARENT_PID);
if (Number.isInteger(parent) && parent > 0)
  setInterval(() => {
    try { process.kill(parent, 0); }
    catch { process.stderr.write("MyCivil3DMcp local service: Civil 3D has exited.\n"); process.exit(0); }
  }, 5000);

// A service left on the port (an older build, or one whose Civil 3D is gone) is asked to
// stop with this session's token, and this one takes the port.
async function takeOver(): Promise<void> {
  const file = process.env.MY_CIVIL3D_CONNECTION_FILE ??
    join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "MyCivil3DMcp", "connection.json");
  try {
    const { token } = JSON.parse(await readFile(file, "utf8")) as { token?: string };
    await fetch(`http://${host}:${port}/api/shutdown`, {
      method: "POST", headers: { "Content-Type": "application/json", "x-my-civil3d-token": token ?? "" }, body: "{}",
      signal: AbortSignal.timeout(3000)
    });
  } catch { /* It may already be gone, or too old to know /api/shutdown. */ }
}

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
