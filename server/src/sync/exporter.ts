// 로그 → 보낼 묶음.
// 새로 쌓인 로그 줄을 비식별 묶음으로 만들어 data/outbox/pending 에 넣는다.
// 드라이브 연결과 상관없이 만든다(연결이 없어도 잃어버리지 않게).
// 마지막 검사에 걸린 묶음은 이유와 함께 data/outbox/blocked 로 가고, 절대 보내지 않는다.

import { randomBytes } from "node:crypto";
import { open, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { install } from "../data/install.js";
import { privateTerms } from "../data/terms.js";
import { writeAtomic } from "../files.js";
import { LOG_FILES, logsDir } from "../logs/workLog.js";
import { dataDir } from "../paths.js";
import { hour, leak } from "./privacy.js";
import { outRecord, type OutRecord } from "./records.js";
import type { SyncState } from "./syncState.js";

export const CLIENT = "my-civil3d-mcp/0.2";
const MAX_RECORDS = 500;          // 묶음 하나의 기록 수
const MAX_READ = 4 * 1024 * 1024; // 파일 하나에서 한 번에 읽는 양

export type Package = {
  schema: 1;
  packageId: string;     // <설치ID>-<시각>-<무작위>
  installId: string;
  client: string;
  createdAt: string;     // 시간 단위까지
  records: OutRecord[];
};

export const outboxDir = (kind: "pending" | "blocked") => join(dataDir(), "outbox", kind);

// 커서(바이트) 뒤에 새로 붙은 완전한 줄들과 새 커서.
// 마지막 줄바꿈 뒤의 조각은 아직 쓰는 중일 수 있어 다음 번으로 미룬다.
// 파일이 커서보다 작아졌으면(지웠다 새로 생김) 처음부터 읽는다.
async function newLines(path: string, from: number): Promise<{ lines: string[]; to: number }> {
  const size = (await stat(path)).size;
  if (size <= from) return { lines: [], to: size < from ? 0 : from };

  const handle = await open(path, "r");
  try {
    const length = Math.min(size - from, MAX_READ);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, from);
    const end = buffer.lastIndexOf(0x0a);
    if (end < 0) return { lines: [], to: from };
    return { lines: buffer.subarray(0, end).toString("utf8").split("\n"), to: from + end + 1 };
  } finally {
    await handle.close();
  }
}

export async function exportLogs(state: SyncState): Promise<{ packages: number; blocked: number; records: number }> {
  // 1) 날짜 폴더마다, 로그 파일마다 새 줄을 읽어 보낼 기록으로 바꾼다.
  const records: OutRecord[] = [];
  const terms = await privateTerms();
  const days = (await readdir(logsDir()).catch(() => [] as string[]))
    .filter(day => /^\d{4}-\d{2}-\d{2}$/.test(day))
    .sort();
  const seen = new Set<string>();

  for (const day of days) {
    for (const file of LOG_FILES) {
      const key = `${day}/${file}`;
      const path = join(logsDir(), day, file);
      const found = await newLines(path, state.cursors[key] ?? 0).catch(() => undefined);
      if (!found) continue;

      seen.add(key);
      for (const line of found.lines) {
        try {
          const record = outRecord(file, JSON.parse(line) as Record<string, unknown>, terms);
          if (record) records.push(record);
        } catch {
          // 깨진 줄은 건너뛴다.
        }
      }
      state.cursors[key] = found.to;
    }
  }

  // 보관 기한으로 지워진 로그의 커서는 버린다.
  for (const key of Object.keys(state.cursors)) if (!seen.has(key)) delete state.cursors[key];

  // 2) MAX_RECORDS 개씩 묶고, 묶음 전체를 마지막으로 검사한다.
  const { installId } = await install();
  let packages = 0;
  let blocked = 0;

  for (let index = 0; index < records.length; index += MAX_RECORDS) {
    const packageId = `${installId}-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
    const item: Package = {
      schema: 1,
      packageId,
      installId,
      client: CLIENT,
      createdAt: hour(new Date().toISOString()),
      records: records.slice(index, index + MAX_RECORDS)
    };
    const text = JSON.stringify(item);
    const reason = leak(text, terms);

    if (reason) {
      const report = { reason, blockedAt: new Date().toISOString(), package: item };
      await writeAtomic(join(outboxDir("blocked"), `${packageId}.json`), JSON.stringify(report, null, 1));
      blocked++;
    } else {
      await writeAtomic(join(outboxDir("pending"), `${packageId}.json`), text);
      packages++;
    }
  }

  state.lastExport = new Date().toISOString();
  return { packages, blocked, records: records.length };
}
