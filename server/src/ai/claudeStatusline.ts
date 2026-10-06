import { mkdir, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ClaudeQuotaSnapshot } from "./types/ClaudeQuotaSnapshot.js";
export type { ClaudeRateWindow } from "./types/ClaudeRateWindow.js";
export type { ClaudeQuotaSnapshot } from "./types/ClaudeQuotaSnapshot.js";

export const claudeQuotaFile = process.env.MY_CIVIL3D_CLAUDE_QUOTA_FILE ?? join(
  process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"),
  "MyCivil3DMcp", "claude-quota.json"
);

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

export function parseClaudeStatusline(value: unknown, now = Date.now()): ClaudeQuotaSnapshot | null {
  const limits = record(record(value).rate_limits);
  const windows: ClaudeQuotaSnapshot["rate_limits"] = {};
  for (const name of ["five_hour", "seven_day"] as const) {
    const window = record(limits[name]);
    const used = window.used_percentage;
    const reset = window.resets_at;
    if (typeof used === "number" && Number.isFinite(used) && used >= 0 && used <= 100 &&
        typeof reset === "number" && Number.isFinite(reset) && reset * 1000 > now) {
      windows[name] = { used_percentage: used, resets_at: reset };
    }
  }
  return Object.keys(windows).length ? { capturedAt: now, rate_limits: windows } : null;
}

export async function runClaudeStatusline(): Promise<void> {
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk.toString();
    if (input.length > 1024 * 1024) return;
  }
  let value: unknown;
  try { value = JSON.parse(input); } catch { return; }
  const snapshot = parseClaudeStatusline(value);
  if (!snapshot) return;
  await mkdir(dirname(claudeQuotaFile), { recursive: true });
  const temporary = `${claudeQuotaFile}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(snapshot), "utf8");
  await rename(temporary, claudeQuotaFile);
  const five = snapshot.rate_limits.five_hour?.used_percentage;
  const seven = snapshot.rate_limits.seven_day?.used_percentage;
  process.stdout.write(`Claude ${five === undefined ? "" : `5h ${five.toFixed(0)}%`}${seven === undefined ? "" : ` 7d ${seven.toFixed(0)}%`}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url).toLowerCase() === resolve(process.argv[1]).toLowerCase())
  runClaudeStatusline().catch(() => { /* Status line must never interrupt Claude Code. */ });
