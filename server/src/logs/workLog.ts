import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { dataDir } from "../paths.js";
import { productVersion } from "../version.js";

// 작업 기록. 이 PC의 data/logs/<날짜>/ 아래에 남는다.
//   turns.jsonl    팔레트 질문 1건 = 1줄 (질문, 답, 도구, 변경, 지식, 토큰, 시간)
//   tools.jsonl    MCP 도구 호출 1건 = 1줄 (걸린 시간, 결과)
//   changes.jsonl  도면 변경 시도 1건 = 1줄 (changes/applyChange.ts)
//   events.jsonl   AI 결과를 사람이 나중에 어떻게 했는지 (tracking/tracker.ts)
// 프롬프트에는 넣지 않는다. 원문이 들어 있으므로 그대로 PC 밖으로 나가지 않는다.
// 보내는 것은 sync/records.ts 가 만든 비식별 사본이다.
// 줄마다 프로그램 버전(appVersion)을 붙인다: 업데이트 전후 기록이 한 묶음에 섞여도 구분된다.
// 기록에 실패해도 답변은 멈추지 않는다. 30일이 지난 폴더는 지운다(sync/retention.ts).

const MAX_TEXT = 8000;   // 한 칸에 남기는 글자 수 한도
export const LOG_FILES = ["turns.jsonl", "tools.jsonl", "changes.jsonl", "events.jsonl"] as const;
export type LogFile = typeof LOG_FILES[number];

// 긴 글은 잘라서 남긴다: "...…(+1234자)"
export const clip = (text: string, max = MAX_TEXT) => text.length > max ? text.slice(0, max) + `…(+${text.length - max}자)` : text;
export const logsDir = () => join(dataDir(), "logs");
// 이 PC 시간대의 날짜 "2026-10-06" (폴더 이름)
export const localDate = (date = new Date()) => date.toLocaleString("sv-SE").slice(0, 10);

// 오늘 폴더의 파일에 한 줄 붙인다. 실패하면 오류 출력만 하고 넘어간다.
async function append(name: LogFile, entry: Record<string, unknown>): Promise<void> {
  try {
    const now = new Date();
    const dir = join(logsDir(), localDate(now));
    await mkdir(dir, { recursive: true });
    await appendFile(join(dir, name), JSON.stringify({ at: now.toISOString(), appVersion: productVersion, ...entry }) + "\n", "utf8");
  } catch (error) {
    process.stderr.write(`MyCivil3DMcp work log was not written: ${String(error)}\n`);
  }
}

export const logTurn = (entry: Record<string, unknown>) => append("turns.jsonl", entry);
export const logTool = (entry: Record<string, unknown>) => append("tools.jsonl", entry);
export const logChangeEntry = (entry: Record<string, unknown>) => append("changes.jsonl", entry);
export const logEvent = (entry: Record<string, unknown>) => append("events.jsonl", entry);

// 어제와 오늘 파일의 줄들(자정을 넘긴 요청도 찾도록).
export async function recentLines(name: LogFile): Promise<Record<string, unknown>[]> {
  const today = new Date();
  const days = [new Date(today.getTime() - 24 * 60 * 60 * 1000), today].map(localDate);
  const lines: Record<string, unknown>[] = [];
  for (const day of days) {
    const text = await readFile(join(logsDir(), day, name), "utf8").catch(() => "");
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try { lines.push(JSON.parse(line) as Record<string, unknown>); } catch { /* 아직 쓰는 중인 줄 */ }
    }
  }
  return lines;
}
