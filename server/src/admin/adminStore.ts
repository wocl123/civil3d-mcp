// 관리자 PC가 보관하는 모든 것 (data/admin). 평범한 파일이고, 처음 쓸 때 메모리로 읽는다.
// 사용자들이 구글 드라이브로 보낸 기록·후보를 여기로 가져온다(adminSync.ts). 작은 팀은 한 달에 기록 수천 건이다.
//   members.json             사용자(드라이브 폴더) 목록: 설치 ID, 폴더 이름, 처음·마지막으로 본 날, 차단 여부
//   packages.txt             이미 받은 묶음 id, 한 줄에 하나
//   records/<YYYY-MM>.jsonl  모든 기록 (설치·묶음과 함께)
//   candidates.json          지식 후보와 검토 상태
//   official.json            지금 적용 중인 승인 지식(사용자 폴더로 나눠 준다)
//   history/v<n>.json        발행한 모든 버전
//   decisions.jsonl          모든 검토 결정
//   cases.json               문제 사례 분류

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { adminDir } from "./adminConfig.js";

// 사용자 하나 = 그 사람이 관리자와 공유한 드라이브 폴더 하나.
//   seen: 관리자가 /중앙 사용자 로 본 적 있음(팔레트 아래 줄의 "새 사용자 n"에서 빠진다)
//   blocked: 관리자가 차단함(그 폴더에서 더 가져오지도, 나눠 주지도 않는다)
export type MemberRow = { installId: string; folder: string; firstSeen: string; lastSeen: string; seen: boolean; blocked?: boolean };

export type StoredRecord = { installId: string; packageId: string; receivedAt: string; record: Record<string, unknown> };

export type CandidateRow = {
  id: string;            // S-1, S-2, ...
  installId: string;
  localId: string;       // 설치 쪽 후보 id (C-20261006-1)
  title: string;
  content: string;
  groupKey: string;      // 같은 내용을 묶는 키 (review.ts)
  parameter?: { key: string; value: number };
  provider?: string;
  at?: string;
  localStatus?: string;  // 그 PC에서 이미 승인했는지
  receivedAt: string;
  status: "pending" | "approved" | "rejected";
  decidedAt?: string;
  reason?: string;       // 반려 사유
};

export type OfficialItem = {
  id: string;            // K-1, K-2, ...
  content: string;
  approvedAt: string;
  parameter?: { key: string; value: number };
  from: string;          // 승인한 검토 항목 id (G-… 또는 P-…)
};

export type Official = { version: number; publishedAt?: string; items: OfficialItem[]; parameters: Record<string, number> };

// 문제 사례 분류(검토자). 키: "<설치ID>:<질문 id>".
//   todo: 처리하기로 함(분류·메모) / done: 처리 끝(고친 버전) / discarded: 버림(내용은 기록에서 지움)
export type CaseCategory = "knowledge" | "code" | "ai" | "other";
export type CaseTriage = { status: "todo" | "done" | "discarded"; category?: CaseCategory; note?: string; version?: string; decidedAt: string };

// 버릴 때 기록에서 지우는 내용 항목(숫자 통계는 남긴다).
const CONTENT_FIELDS = ["question", "answer", "input", "title", "labels", "reason"];

export type Decision = { at: string; id: string; decision: string; reason?: string; content?: string; version: number };

const path = (...parts: string[]) => join(adminDir(), ...parts);

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path(file), "utf8")) as T;
  } catch {
    return fallback;
  }
}

// 임시 파일에 쓰고 바꿔치기(반쯤 쓴 파일이 남지 않게).
function writeJson(file: string, value: unknown): void {
  const target = path(file);
  writeFileSync(target + ".tmp", JSON.stringify(value, null, 1), "utf8");
  renameSync(target + ".tmp", target);
}

// 한 줄에 JSON 하나인 파일. 깨진 줄은 건너뛴다.
function readLines<T>(file: string): T[] {
  if (!existsSync(path(file))) return [];
  return readFileSync(path(file), "utf8").split("\n").filter(Boolean).flatMap(line => {
    try {
      return [JSON.parse(line) as T];
    } catch {
      return [];
    }
  });
}

export class AdminStore {
  members: Record<string, MemberRow>;
  packages: Set<string>;
  records: StoredRecord[];
  candidates: CandidateRow[];
  official: Official;
  decisions: Decision[];
  cases: Record<string, CaseTriage>;

  constructor() {
    mkdirSync(path("records"), { recursive: true });
    mkdirSync(path("history"), { recursive: true });
    this.members = readJson("members.json", {});
    this.packages = new Set(existsSync(path("packages.txt"))
      ? readFileSync(path("packages.txt"), "utf8").split("\n").filter(Boolean)
      : []);
    this.records = readdirSync(path("records"))
      .filter(name => name.endsWith(".jsonl"))
      .sort()
      .flatMap(name => readLines<StoredRecord>(join("records", name)));
    this.candidates = readJson("candidates.json", []);
    this.official = readJson("official.json", { version: 0, items: [], parameters: {} });
    this.decisions = readLines("decisions.jsonl");
    this.cases = readJson("cases.json", {});
  }

  saveMembers(): void {
    writeJson("members.json", this.members);
  }

  // 묶음 하나를 받는다: 기록은 달별 파일에 붙이고, 묶음 id를 남긴다.
  addPackage(installId: string, packageId: string, records: Record<string, unknown>[]): void {
    const receivedAt = new Date().toISOString();
    const rows = records.map(record => ({ installId, packageId, receivedAt, record }));
    if (rows.length) {
      const lines = rows.map(row => JSON.stringify(row)).join("\n") + "\n";
      appendFileSync(path("records", `${receivedAt.slice(0, 7)}.jsonl`), lines, "utf8");
    }
    appendFileSync(path("packages.txt"), packageId + "\n", "utf8");
    this.packages.add(packageId);
    this.records.push(...rows);
  }

  saveCandidates(): void {
    writeJson("candidates.json", this.candidates);
  }

  // 새 버전의 승인 지식을 발행한다(버전 +1, 기록 보관, 결정 기록).
  publish(official: Official, decision: Omit<Decision, "at" | "version">): void {
    official.version = this.official.version + 1;
    official.publishedAt = new Date().toISOString();
    writeJson(join("history", `v${official.version}.json`), official);
    writeJson("official.json", official);
    this.official = official;
    this.decide(decision);
  }

  saveCases(): void {
    writeJson("cases.json", this.cases);
  }

  // 한 질문(turnId)에 딸린 기록들에서 내용 항목을 지운다. 지운 기록 수를 돌려준다.
  scrubCase(installId: string, turnId: string): number {
    return this.scrubWhere(key => key === `${installId}:${turnId}`);
  }

  // 질문 키("<설치ID>:<질문 id>")가 조건에 맞는 기록들의 내용 항목을 지운다(달별 파일을 다시 쓴다). 숫자 통계는 남는다.
  scrubWhere(match: (key: string) => boolean): number {
    const keyOf = (row: StoredRecord) => {
      const record = row.record as Record<string, unknown>;
      const id = record.id ?? record.turnId;
      return typeof id === "string" ? `${row.installId}:${id}` : undefined;
    };
    const hasContent = (row: StoredRecord) => CONTENT_FIELDS.some(field => field in (row.record as Record<string, unknown>));
    const target = (row: StoredRecord) => { const key = keyOf(row); return !!key && hasContent(row) && match(key); };
    const strip = (row: StoredRecord) => { for (const field of CONTENT_FIELDS) delete (row.record as Record<string, unknown>)[field]; };
    let scrubbed = 0;
    for (const row of this.records) if (target(row)) { strip(row); scrubbed++; }
    if (!scrubbed) return 0;
    for (const name of readdirSync(path("records")).filter(file => file.endsWith(".jsonl"))) {
      const lines = readLines<StoredRecord>(join("records", name));
      let changed = false;
      for (const row of lines) if (target(row)) { strip(row); changed = true; }
      if (changed) {
        const file = path("records", name);
        writeFileSync(file + ".tmp", lines.map(row => JSON.stringify(row)).join("\n") + "\n", "utf8");
        renameSync(file + ".tmp", file);
      }
    }
    return scrubbed;
  }

  // 검토 결정 하나를 기록한다.
  decide(decision: Omit<Decision, "at" | "version">): void {
    const row: Decision = { at: new Date().toISOString(), ...decision, version: this.official.version };
    appendFileSync(path("decisions.jsonl"), JSON.stringify(row) + "\n", "utf8");
    this.decisions.push(row);
  }
}

// 서비스 안에서 하나만 쓴다(동기화와 팔레트 명령이 같은 것을 본다).
let shared: AdminStore | undefined;
export const adminStore = (): AdminStore => shared ??= new AdminStore();
