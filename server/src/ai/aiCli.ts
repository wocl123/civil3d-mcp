// AI CLI(Claude, Codex, Gemini) 실행과 로그인 상태 관리.
//   - runCli:          CLI 하나를 실행하고 출력을 모은다
//   - verifyProvider:  로그인 확인 (세션 시작)
//   - askProvider:     팔레트 질문 하나를 CLI에 보내고 답을 받는다

import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { parseUsage } from "./usage.js";
import { paletteLaunch } from "./paletteWorkspace.js";
import { cliPath, locateCli } from "./cliLocator.js";
import type { TokenUsage } from "./types/TokenUsage.js";
import type { Provider } from "./types/Provider.js";
import type { ProviderState } from "./types/ProviderState.js";
import type { CliResult } from "./types/CliResult.js";
import type { ChatEvent } from "./types/ChatEvent.js";
export type { Provider } from "./types/Provider.js";
export type { ProviderState } from "./types/ProviderState.js";

export const PROVIDERS = ["claude", "codex", "gemini"] as const;

// 세션: 로그인을 확인하면 마지막 사용부터 SESSION_MS 동안 유효하다.
//   - 그 AI에 질문할 때마다 시간이 다시 시작된다(touchProvider).
//   - 그만큼 쓰지 않으면 "unchecked"로 돌아가고, 사용자가 다시 고르면 로그인을 새로 확인한다.
//   - 팔레트는 남은 시간을 보여 준다(sessionInfo).
// MY_CIVIL3D_AI_SESSION_MINUTES 로 길이를 바꿀 수 있다(기본 30분).
const verified = new Map<Provider, { state: ProviderState; checkedAt: number }>();
const SESSION_MS = Math.max(1, Number(process.env.MY_CIVIL3D_AI_SESSION_MINUTES ?? "30") || 30) * 60 * 1000;

const MAX_OUTPUT = 2 * 1024 * 1024;   // CLI 출력이 이보다 크면 멈춘다

export function isProvider(value: unknown): value is Provider {
  return typeof value === "string" && PROVIDERS.includes(value as Provider);
}

// CLI 하나를 실행한다.
//   - 명령 인자는 모두 이 모듈이 정한다. 사용자 글은 stdin으로만 보낸다(cmd.exe 인자 해석을 거치지 않게).
//   - onLine: 출력 한 줄마다 부른다(진행 상황 표시용).
async function runCli(provider: Provider, args: string[], input = "", timeoutMs = 15000,
  cwd = tmpdir(), extraEnv: Record<string, string> = {}, onLine?: (line: string) => void): Promise<CliResult> {
  const windows = process.platform === "win32";
  const executable = windows ? "cmd.exe" : provider;
  const commandArgs = windows ? ["/d", "/s", "/c", provider, ...args] : args;

  // CLI를 실제 위치에서 찾고(cliLocator.ts), 그 폴더를 PATH 맨 앞에 둔다.
  // 그래서 Civil 3D가 켜진 뒤 설치한 CLI도 실행된다. Windows는 PATH 키 이름이 "Path"다.
  const location = await locateCli(provider);
  const env: Record<string, string | undefined> = { ...process.env, ...extraEnv, CI: "1" };
  if (location) {
    for (const key of Object.keys(env)) if (/^path$/i.test(key)) delete env[key];
    env[windows ? "Path" : "PATH"] = await cliPath(provider, location);
  }

  return await new Promise<CliResult>((resolve, reject) => {
    const child = spawn(executable, commandArgs, { cwd, windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env });
    let stdout = "";
    let stderr = "";
    let pending = "";      // 아직 줄바꿈이 오지 않은 stdout 조각
    let settled = false;

    // 시간 초과
    const timer = setTimeout(() => {
      child.kill();
      if (!settled) {
        settled = true;
        reject(new Error(`${provider} timed out.`));
      }
    }, timeoutMs);

    // 출력 모으기. stdout은 줄 단위로 onLine에도 넘긴다.
    const append = (target: "stdout" | "stderr", chunk: Buffer) => {
      if (target === "stdout") {
        const text = chunk.toString("utf8");
        stdout += text;
        if (onLine) {
          pending += text;
          const lines = pending.split("\n");
          pending = lines.pop() ?? "";
          for (const line of lines) if (line.trim()) onLine(line);
        }
      } else {
        stderr += chunk.toString("utf8");
      }
      if (stdout.length + stderr.length > MAX_OUTPUT) child.kill();
    };

    child.stdout.on("data", (chunk: Buffer) => append("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => append("stderr", chunk));
    child.stdin.on("error", () => { /* CLI가 stdin을 다 읽기 전에 끝날 수 있다. */ });
    child.on("error", (error) => {
      if (!settled) { settled = true; clearTimeout(timer); reject(error); }
    });
    child.on("close", (code) => {
      if (!settled) { settled = true; clearTimeout(timer); resolve({ code: code ?? 1, stdout, stderr }); }
    });

    child.stdin.end(input);
  });
}

async function isInstalled(provider: Provider): Promise<boolean> {
  return (await locateCli(provider)) !== undefined;
}

// 현재 상태: missing(설치 안 됨) / unchecked(확인 전 또는 세션 끝) / ready / unauthenticated.
export async function getProviderState(provider: Provider): Promise<ProviderState> {
  if (!(await isInstalled(provider))) return "missing";
  const record = verified.get(provider);
  if (!record || Date.now() - record.checkedAt > SESSION_MS) return "unchecked";
  return record.state;
}

// AI를 쓰면 세션 시간이 다시 시작된다. 이미 끝난 세션은 되살리지 않는다.
export function touchProvider(provider: Provider): void {
  const record = verified.get(provider);
  if (record?.state === "ready" && Date.now() - record.checkedAt <= SESSION_MS) record.checkedAt = Date.now();
}

// 사용 가능한 AI의 남은 세션 시간(팔레트 표시용). 세션이 없으면 undefined.
export function sessionInfo(provider: Provider): { expiresInMs: number; sessionMs: number } | undefined {
  const record = verified.get(provider);
  if (record?.state !== "ready") return undefined;
  const left = SESSION_MS - (Date.now() - record.checkedAt);
  return left > 0 ? { expiresInMs: left, sessionMs: SESSION_MS } : undefined;
}

// 로그인을 확인하고, 되면 세션을 시작한다.
export async function verifyProvider(provider: Provider): Promise<ProviderState> {
  if (!(await isInstalled(provider))) {
    verified.set(provider, { state: "missing", checkedAt: Date.now() });
    return "missing";
  }
  try {
    // Claude·Codex는 로그인 상태 명령이 있다.
    // Gemini는 없어서 짧은 질문을 하나 보내 실제로 답하는지 본다(사용량을 조금 쓴다).
    const result = provider === "claude"
      ? await runCli(provider, ["auth", "status"], "", 15000)
      : provider === "codex"
        ? await runCli(provider, ["login", "status"], "", 15000)
        : await runCli(provider, ["--output-format", "json", "-p", "Reply with OK."], "", 60000);

    let ready = result.code === 0;
    if (provider === "gemini" && ready) {
      try {
        const output = JSON.parse(result.stdout) as { response?: string; error?: unknown };
        ready = typeof output.response === "string" && !output.error;
      } catch {
        ready = false;
      }
    }

    const state: ProviderState = ready ? "ready" : "unauthenticated";
    verified.set(provider, { state, checkedAt: Date.now() });
    return state;
  } catch {
    verified.set(provider, { state: "unauthenticated", checkedAt: Date.now() });
    return "unauthenticated";
  }
}

// CLI가 내보내는 JSON 이벤트 한 줄을 팔레트 진행 표시로 바꾼다.
//   Claude: 답 글자를 조금씩(text_delta) 보내고, 도구 호출(tool_use)을 알린다.
//   Codex:  도구 호출 시작을 알리고, 답은 다 쓴 뒤에 한 번에 보낸다.
function chatEvent(provider: Provider, line: string): ChatEvent | undefined {
  let event: Record<string, any>;
  try {
    event = JSON.parse(line) as Record<string, any>;
  } catch {
    return undefined;
  }

  if (provider === "claude") {
    const delta = event.type === "stream_event" ? event.event?.delta : undefined;
    if (delta?.type === "text_delta" && typeof delta.text === "string") return { type: "text", text: delta.text };

    const tool = event.type === "assistant"
      ? (event.message?.content as any[] | undefined)?.find(part => part?.type === "tool_use")
      : undefined;
    // 도구 이름 앞의 "mcp__서버이름__"은 뗀다.
    if (typeof tool?.name === "string") return { type: "tool", name: tool.name.replace(/^mcp__[^_]+__/, "") };
  }

  if (provider === "codex") {
    if (event.type === "item.started" && event.item?.type === "mcp_tool_call" && typeof event.item.tool === "string")
      return { type: "tool", name: event.item.tool };
    if (event.type === "item.completed" && event.item?.type === "agent_message" && typeof event.item.text === "string")
      return { type: "text", text: event.item.text };
  }
  return undefined;
}

// 팔레트 질문 하나를 AI에게 보내고 답과 토큰 사용량을 받는다.
//   tools: true면 이 프로젝트의 MCP 도구로 도면을 볼 수 있다. false면 프롬프트만으로 답한다.
export async function askProvider(provider: Provider, prompt: string,
  options: { tools?: boolean; onEvent?: (event: ChatEvent) => void; requestId?: string; offeredFixes?: string[] } = {}):
  Promise<{ answer: string; usage: TokenUsage }> {
  if (await getProviderState(provider) !== "ready")
    throw new Error(`${provider} account is not verified. Verify its login first.`);

  // 1) CLI 실행 (명령 인자와 작업 폴더는 paletteWorkspace.ts 가 정한다)
  const launch = await paletteLaunch(provider, options.tools === true, options.requestId, options.offeredFixes);
  const onEvent = options.onEvent;
  const onLine = onEvent
    ? (line: string) => { const event = chatEvent(provider, line); if (event) onEvent(event); }
    : undefined;
  const result = await runCli(provider, launch.args, prompt, 200000, launch.cwd, launch.env, onLine);

  // 2) 실패: CLI 옵션이나 MCP 서버 문제일 수도 있으니 마지막 오류 메시지를 붙인다.
  if (result.code !== 0) {
    const detail = result.stderr.trim().split(/\r?\n/).filter(Boolean).slice(-2).join(" ").slice(0, 400);
    throw new Error(`${provider} failed. Check its account login in the CLI.${detail ? ` (${detail})` : ""}`);
  }

  // 3) 답 꺼내기 (CLI마다 출력 형식이 다르다)
  if (provider === "claude") {
    // 스트림의 마지막 "result" 이벤트가 일반 JSON 출력과 같은 모양이다.
    const last = result.stdout.trim().split(/\r?\n/).reverse().find(line => line.includes('"type":"result"')) ?? result.stdout;
    const parsed = JSON.parse(last) as { result?: string; is_error?: boolean };
    if (parsed.is_error || typeof parsed.result !== "string") throw new Error("Claude returned no answer.");
    return { answer: parsed.result, usage: parseUsage(provider, parsed) };
  }

  if (provider === "gemini") {
    const parsed = JSON.parse(result.stdout) as { response?: string; error?: unknown };
    if (parsed.error || typeof parsed.response !== "string") throw new Error("Gemini returned no answer.");
    return { answer: parsed.response, usage: parseUsage(provider, parsed) };
  }

  // Codex: 이벤트를 뒤에서부터 보며 마지막 답(agent_message)과 사용량(turn.completed)을 찾는다.
  const events = result.stdout.split(/\r?\n/).filter(Boolean);
  let answer: string | undefined;
  let usage: TokenUsage = parseUsage(provider, {});
  let foundUsage = false;
  for (let index = events.length - 1; index >= 0; index--) {
    try {
      const event = JSON.parse(events[index]) as { type?: string; item?: { type?: string; text?: string }; usage?: unknown };
      if (event.type === "turn.completed" && !foundUsage) {
        usage = parseUsage(provider, event);
        foundUsage = true;
      }
      if (event.type === "item.completed" && event.item?.type === "agent_message" && event.item.text)
        answer ??= event.item.text;
    } catch {
      // JSON이 아닌 진단 출력은 건너뛴다.
    }
  }
  if (!answer) throw new Error("Codex returned no final answer.");
  return { answer, usage };
}
