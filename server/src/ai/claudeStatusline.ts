// Claude Code 상태줄 명령.
// Claude Code는 상태줄 명령에 사용 한도(5시간·7일 사용률)를 JSON으로 넘긴다.
// 그것을 claude-quota.json 에 저장해 팔레트가 남은 한도를 보여 줄 수 있게 하고,
// 상태줄에는 "Claude 5h 40% 7d 12%"처럼 한 줄을 출력한다.

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
    ? value as Record<string, unknown>
    : {};
}

// 상태줄 입력에서 사용 한도를 꺼낸다. 올바른 값(0~100%, 아직 안 지난 재설정 시각)만 받는다.
export function parseClaudeStatusline(value: unknown, now = Date.now()): ClaudeQuotaSnapshot | null {
  const limits = record(record(value).rate_limits);
  const windows: ClaudeQuotaSnapshot["rate_limits"] = {};

  for (const name of ["five_hour", "seven_day"] as const) {
    const window = record(limits[name]);
    const used = window.used_percentage;
    const reset = window.resets_at;
    const validUsed = typeof used === "number" && Number.isFinite(used) && used >= 0 && used <= 100;
    const validReset = typeof reset === "number" && Number.isFinite(reset) && reset * 1000 > now;
    if (validUsed && validReset) windows[name] = { used_percentage: used, resets_at: reset };
  }
  return Object.keys(windows).length ? { capturedAt: now, rate_limits: windows } : null;
}

export async function runClaudeStatusline(): Promise<void> {
  // 1) stdin 읽기 (1 MB를 넘으면 무시)
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk.toString();
    if (input.length > 1024 * 1024) return;
  }

  let value: unknown;
  try {
    value = JSON.parse(input);
  } catch {
    return;
  }
  const snapshot = parseClaudeStatusline(value);
  if (!snapshot) return;

  // 2) 파일에 저장 (임시 파일에 쓰고 바꿔치기)
  await mkdir(dirname(claudeQuotaFile), { recursive: true });
  const temporary = `${claudeQuotaFile}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(snapshot), "utf8");
  await rename(temporary, claudeQuotaFile);

  // 3) 상태줄 한 줄
  const five = snapshot.rate_limits.five_hour?.used_percentage;
  const seven = snapshot.rate_limits.seven_day?.used_percentage;
  const fiveText = five === undefined ? "" : `5h ${five.toFixed(0)}%`;
  const sevenText = seven === undefined ? "" : ` 7d ${seven.toFixed(0)}%`;
  process.stdout.write(`Claude ${fiveText}${sevenText}\n`);
}

// 이 파일을 직접 실행했을 때만 돈다. 상태줄은 어떤 경우에도 Claude Code를 방해하면 안 되므로 오류를 삼킨다.
if (process.argv[1] && fileURLToPath(import.meta.url).toLowerCase() === resolve(process.argv[1]).toLowerCase())
  runClaudeStatusline().catch(() => { /* 무시 */ });
