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

const verified = new Map<Provider, { state: ProviderState; checkedAt: number }>();
const VERIFY_TTL_MS = 5 * 60 * 1000;

export function isProvider(value: unknown): value is Provider {
  return typeof value === "string" && PROVIDERS.includes(value as Provider);
}

async function runCli(provider: Provider, args: string[], input = "", timeoutMs = 15000,
  cwd = tmpdir(), extraEnv: Record<string, string> = {}, onLine?: (line: string) => void): Promise<CliResult> {
  // All command arguments are fixed by this module. User text travels on stdin,
  // never through cmd.exe argument parsing on Windows.
  const windows = process.platform === "win32";
  const executable = windows ? "cmd.exe" : provider;
  const commandArgs = windows ? ["/d", "/s", "/c", provider, ...args] : args;
  // The CLI is found where it really is (cliLocator.ts), and its folder leads PATH, so a
  // CLI installed after Civil 3D started still runs. Windows keys PATH as "Path".
  const location = await locateCli(provider);
  const env: Record<string, string | undefined> = { ...process.env, ...extraEnv, CI: "1" };
  if (location) {
    for (const key of Object.keys(env)) if (/^path$/i.test(key)) delete env[key];
    env[windows ? "Path" : "PATH"] = await cliPath(provider, location);
  }
  return await new Promise<CliResult>((resolve, reject) => {
    const child = spawn(executable, commandArgs, {
      cwd, windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env
    });
    let stdout = "";
    let stderr = "";
    let pending = "";
    let settled = false;
    const timer = setTimeout(() => {
      child.kill();
      if (!settled) {
        settled = true;
        reject(new Error(`${provider} timed out.`));
      }
    }, timeoutMs);
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
      }
      else stderr += chunk.toString("utf8");
      if (stdout.length + stderr.length > 2 * 1024 * 1024) child.kill();
    };
    child.stdout.on("data", (chunk: Buffer) => append("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => append("stderr", chunk));
    child.stdin.on("error", () => { /* The CLI may exit before consuming stdin. */ });
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

// A login confirmed earlier is confirmed again on its own once it is older than the TTL,
// so an AI the user chose does not drop out of the palette after a few idle minutes.
// Claude and Codex have a cheap local status command; Gemini's check costs quota, so it
// waits for the user to choose it again.
const AUTO_RECHECK = new Set<Provider>(["claude", "codex"]);
const rechecking = new Map<Provider, Promise<ProviderState>>();

export async function getProviderState(provider: Provider): Promise<ProviderState> {
  if (!(await isInstalled(provider))) return "missing";
  const record = verified.get(provider);
  if (record && Date.now() - record.checkedAt <= VERIFY_TTL_MS) return record.state;
  if (record?.state === "ready" && AUTO_RECHECK.has(provider)) {
    let running = rechecking.get(provider);
    if (!running) {
      running = verifyProvider(provider).finally(() => rechecking.delete(provider));
      rechecking.set(provider, running);
    }
    return running;
  }
  return "unchecked";
}

export async function verifyProvider(provider: Provider): Promise<ProviderState> {
  if (!(await isInstalled(provider))) {
    verified.set(provider, { state: "missing", checkedAt: Date.now() });
    return "missing";
  }
  try {
    const result = provider === "claude"
      ? await runCli(provider, ["auth", "status"], "", 15000)
      : provider === "codex"
        ? await runCli(provider, ["login", "status"], "", 15000)
        // Gemini CLI has no documented noninteractive auth-status command.
        // A short headless request confirms the cached login actually works.
        : await runCli(provider, ["--output-format", "json", "-p", "Reply with OK."], "", 60000);
    let ready = result.code === 0;
    if (provider === "gemini" && ready) {
      try {
        const output = JSON.parse(result.stdout) as { response?: string; error?: unknown };
        ready = typeof output.response === "string" && !output.error;
      } catch { ready = false; }
    }
    const state: ProviderState = ready ? "ready" : "unauthenticated";
    verified.set(provider, { state, checkedAt: Date.now() });
    return state;
  } catch {
    verified.set(provider, { state: "unauthenticated", checkedAt: Date.now() });
    return "unauthenticated";
  }
}

// With tools, the AI can call this project's read-only MCP tools to look at the drawing.
// Without them, it answers only from the prompt.
// Turns one line of the CLI's JSON event stream into palette progress.
// Claude streams text deltas; Codex reports its answer only when it is complete.
function chatEvent(provider: Provider, line: string): ChatEvent | undefined {
  let event: Record<string, any>;
  try { event = JSON.parse(line) as Record<string, any>; } catch { return undefined; }
  if (provider === "claude") {
    const delta = event.type === "stream_event" ? event.event?.delta : undefined;
    if (delta?.type === "text_delta" && typeof delta.text === "string") return { type: "text", text: delta.text };
    const tool = event.type === "assistant" ? (event.message?.content as any[] | undefined)?.find(part => part?.type === "tool_use") : undefined;
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

export async function askProvider(provider: Provider, prompt: string,
  options: { tools?: boolean; onEvent?: (event: ChatEvent) => void; requestId?: string; offeredFixes?: string[] } = {}): Promise<{ answer: string; usage: TokenUsage }> {
  if (await getProviderState(provider) !== "ready")
    throw new Error(`${provider} account is not verified. Verify its login first.`);

  const launch = await paletteLaunch(provider, options.tools === true, options.requestId, options.offeredFixes);
  const onEvent = options.onEvent;
  const result = await runCli(provider, launch.args, prompt, 200000, launch.cwd, launch.env,
    onEvent ? line => { const event = chatEvent(provider, line); if (event) onEvent(event); } : undefined);

  if (result.code !== 0) {
    // The CLI can also fail on its options or the MCP server, so keep its last message.
    const detail = result.stderr.trim().split(/\r?\n/).filter(Boolean).slice(-2).join(" ").slice(0, 400);
    throw new Error(`${provider} failed. Check its account login in the CLI.${detail ? ` (${detail})` : ""}`);
  }
  if (provider === "claude") {
    // The stream ends with a "result" event shaped like the plain JSON output.
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
  const events = result.stdout.split(/\r?\n/).filter(Boolean);
  let answer: string | undefined;
  let usage: TokenUsage = parseUsage(provider, {});
  let foundUsage = false;
  for (let index = events.length - 1; index >= 0; index--) {
    try {
      const event = JSON.parse(events[index]) as {
        type?: string; item?: { type?: string; text?: string }; usage?: unknown
      };
      if (event.type === "turn.completed" && !foundUsage) {
        usage = parseUsage(provider, event);
        foundUsage = true;
      }
      if (event.type === "item.completed" && event.item?.type === "agent_message" && event.item.text)
        answer ??= event.item.text;
    } catch { /* Ignore non-JSON diagnostics. */ }
  }
  if (!answer) throw new Error("Codex returned no final answer.");
  return { answer, usage };
}
