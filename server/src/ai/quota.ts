import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { tmpdir } from "node:os";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Provider } from "./aiCli.js";
import { claudeQuotaFile, parseClaudeStatusline } from "./claudeStatusline.js";
import type { QuotaWindow } from "./types/QuotaWindow.js";
import type { QuotaInfo } from "./types/QuotaInfo.js";
export type { QuotaWindow } from "./types/QuotaWindow.js";
export type { QuotaInfo } from "./types/QuotaInfo.js";

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

export function parseCodexQuota(value: unknown): QuotaInfo {
  const data = record(value);
  const grouped = record(data.rateLimitsByLimitId);
  const snapshot = record(grouped.codex ?? data.rateLimits);
  const windows: QuotaWindow[] = [];
  for (const key of ["primary", "secondary"] as const) {
    const window = record(snapshot[key]);
    const used = window.usedPercent;
    if (typeof used !== "number" || !Number.isFinite(used)) continue;
    const minutes = typeof window.windowDurationMins === "number" ? window.windowDurationMins : null;
    const label = minutes === 300 ? "5시간" : minutes === 10080 ? "7일" :
      minutes !== null ? `${minutes}분` : key === "primary" ? "기본 한도" : "추가 한도";
    const reset = typeof window.resetsAt === "number" && Number.isFinite(window.resetsAt)
      ? new Date(window.resetsAt * 1000).toISOString() : null;
    windows.push({
      label, usedPercent: Math.max(0, Math.min(100, used)),
      remainingPercent: Math.max(0, Math.min(100, 100 - used)), resetsAt: reset
    });
  }
  return {
    status: windows.length ? "available" : "unavailable",
    windows,
    ordinaryUsageAllowed: typeof data.ordinaryUsageAllowed === "boolean" ? data.ordinaryUsageAllowed : null,
    message: windows.length ? "" : "현재 계정의 한도 정보를 제공하지 않습니다."
  };
}

export function parseClaudeQuota(value: unknown, now = Date.now()): QuotaInfo {
  const stored = record(value);
  const capturedAt = stored.capturedAt;
  const snapshot = parseClaudeStatusline(stored, now);
  const windows: QuotaWindow[] = [];
  if (typeof capturedAt === "number" && Number.isFinite(capturedAt) &&
      capturedAt <= now && now - capturedAt <= 60 * 60 * 1000 && snapshot) {
    for (const [key, label] of [["five_hour", "5h"], ["seven_day", "7d"]] as const) {
      const window = snapshot.rate_limits[key];
      if (!window) continue;
      windows.push({ label, usedPercent: window.used_percentage,
        remainingPercent: 100 - window.used_percentage,
        resetsAt: new Date(window.resets_at * 1000).toISOString() });
    }
  }
  return { status: windows.length ? "available" : "unavailable", windows,
    ordinaryUsageAllowed: null,
    message: windows.length ? "" : "Claude quota snapshot is missing or stale. Sign in, then use Claude Code with the configured status line." };
}

export function parseClaudeSdkQuota(value: unknown): QuotaInfo {
  const result = record(value);
  if (result.rate_limits_available === false) return {
    status: "unsupported", windows: [], ordinaryUsageAllowed: null,
    message: "이 Claude 계정에는 구독 사용 한도가 적용되지 않습니다."
  };
  const limits = record(result.rate_limits);
  const windows: QuotaWindow[] = [];
  for (const [key, label] of [["five_hour", "5시간"], ["seven_day", "7일"]] as const) {
    const window = record(limits[key]);
    const used = window.utilization;
    const reset = window.resets_at;
    if (typeof used !== "number" || !Number.isFinite(used) || used < 0 || used > 100) continue;
    const timestamp = typeof reset === "string" ? Date.parse(reset) : NaN;
    windows.push({ label, usedPercent: used, remainingPercent: 100 - used,
      resetsAt: Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null });
  }
  return { status: windows.length ? "available" : "unavailable", windows,
    ordinaryUsageAllowed: null,
    message: windows.length ? "" : "Claude 계정 한도 정보가 반환되지 않았습니다." };
}

const claudeHelper = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "claude-quota", "readQuota.mjs");
let claudeCache: { at: number; quota: QuotaInfo } | null = null;

async function queryClaudeQuota(): Promise<QuotaInfo> {
  return await new Promise<QuotaInfo>((resolve, reject) => {
    const child = spawn(process.execPath, [claudeHelper], {
      cwd: tmpdir(), env: { ...process.env, CI: "1" }, windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let output = "";
    let settled = false;
    const finish = (quota?: QuotaInfo, error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(quota!);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(undefined, new Error("Claude 한도 조회 시간이 초과됐습니다."));
    }, 35000);
    child.stdout.on("data", chunk => {
      output += chunk.toString("utf8");
      if (output.length > 64 * 1024) child.kill();
    });
    child.stderr.resume();
    child.on("error", error => finish(undefined, error));
    child.on("close", code => {
      if (code !== 0) return finish(undefined, new Error("Claude SDK 한도 조회에 실패했습니다."));
      try { finish(parseClaudeSdkQuota(JSON.parse(output))); }
      catch { finish(undefined, new Error("Claude SDK 한도 응답을 읽지 못했습니다.")); }
    });
  });
}

async function readClaudeQuota(forceRefresh: boolean): Promise<QuotaInfo> {
  if (!forceRefresh && claudeCache && Date.now() - claudeCache.at < 45000)
    return claudeCache.quota;
  try {
    const quota = await queryClaudeQuota();
    if (quota.status !== "unavailable") {
      claudeCache = { at: Date.now(), quota };
      return quota;
    }
  } catch { /* Fall back to a status-line snapshot if one exists. */ }
  try {
    const snapshot = parseClaudeQuota(JSON.parse(await readFile(claudeQuotaFile, "utf8")));
    if (snapshot.status === "available") return snapshot;
  } catch { /* No snapshot has been captured. */ }
  return { status: "unavailable", windows: [], ordinaryUsageAllowed: null,
    message: "Claude 한도를 조회하지 못했습니다. CLI 로그인과 네트워크 상태를 확인하세요." };
}

async function readCodexQuota(): Promise<QuotaInfo> {
  const windows = process.platform === "win32";
  const child = spawn(windows ? "cmd.exe" : "codex",
    windows ? ["/d", "/s", "/c", "codex", "app-server", "--listen", "stdio://"]
      : ["app-server", "--listen", "stdio://"],
    { cwd: tmpdir(), env: { ...process.env, CI: "1" }, windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
  child.stdin.on("error", () => { /* Child may exit before reading. */ });
  const lines = createInterface({ input: child.stdout });
  return await new Promise<QuotaInfo>((resolve, reject) => {
    let settled = false;
    const finish = (result?: QuotaInfo, error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdin.end();
      lines.close();
      if (error) reject(error); else resolve(result!);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(undefined, new Error("Codex 한도 조회 시간이 초과됐습니다."));
    }, 20000);
    child.on("error", error => finish(undefined, error));
    child.on("close", () => finish(undefined, new Error("Codex 한도 조회 응답이 없습니다.")));
    lines.on("line", line => {
      let message: Record<string, unknown>;
      try { message = record(JSON.parse(line)); } catch { return; }
      if (message.id === 1) {
        if (message.error) return finish(undefined, new Error("Codex 초기화에 실패했습니다."));
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} }) + "\n");
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "account/rateLimits/read", params: {} }) + "\n");
      } else if (message.id === 2) {
        if (message.error) return finish(undefined, new Error("Codex 한도 조회를 지원하지 않거나 계정 인증에 실패했습니다."));
        finish(parseCodexQuota(message.result));
      }
    });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
      clientInfo: { name: "my_civil3d_mcp", title: "My Civil 3D MCP", version: "0.1.0" }
    } }) + "\n");
  });
}

export async function getQuota(provider: Provider, forceRefresh = false): Promise<QuotaInfo> {
  if (provider === "claude") return await readClaudeQuota(forceRefresh);
  if (provider === "gemini") return {
    status: "unsupported", windows: [], ordinaryUsageAllowed: null,
    message: "Gemini CLI does not expose a documented headless quota read. Check /stats model in Gemini."
  };
  try { return await readCodexQuota(); }
  catch { return {
    status: "unavailable", windows: [], ordinaryUsageAllowed: null,
    message: "Codex 계정 한도를 조회하지 못했습니다. CLI 로그인과 네트워크 상태를 확인하세요."
  }; }
}

