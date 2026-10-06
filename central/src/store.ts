import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "./config.js";

// Everything the central server keeps, as plain files under its data folder, read into
// memory at start. Small teams send a few thousand records a month; when that grows,
// only this file needs to change to use a database.
//   installs.json           enrolled installs (token hashes only)
//   packages.txt            ids of packages already taken, one per line
//   records/<YYYY-MM>.jsonl every record with its install and package
//   candidates.json         knowledge candidates and their review state
//   official.json           the approved central knowledge now in force
//   history/v<n>.json       every published version
//   decisions.jsonl         every review decision
export type InstallRow = { installId: string; tokenHash: string; enrolledAt: string; lastSeen: string };
export type StoredRecord = { installId: string; packageId: string; receivedAt: string; record: Record<string, unknown> };
export type CandidateRow = {
  id: string; installId: string; localId: string; title: string; content: string; groupKey: string;
  parameter?: { key: string; value: number }; provider?: string; at?: string; localStatus?: string; receivedAt: string;
  status: "pending" | "approved" | "rejected"; decidedAt?: string; reason?: string;
};
export type OfficialItem = { id: string; content: string; approvedAt: string; parameter?: { key: string; value: number }; from: string };
export type Official = { version: number; publishedAt?: string; items: OfficialItem[]; parameters: Record<string, number> };
export type Decision = { at: string; id: string; decision: string; reason?: string; content?: string; version: number };

const path = (...parts: string[]) => join(dataDir, ...parts);

function readJson<T>(file: string, fallback: T): T {
  try { return JSON.parse(readFileSync(path(file), "utf8")) as T; } catch { return fallback; }
}

function writeJson(file: string, value: unknown): void {
  const target = path(file);
  writeFileSync(target + ".tmp", JSON.stringify(value, null, 1), "utf8");
  renameSync(target + ".tmp", target);
}

function readLines<T>(file: string): T[] {
  if (!existsSync(path(file))) return [];
  return readFileSync(path(file), "utf8").split("\n").filter(Boolean).flatMap(line => {
    try { return [JSON.parse(line) as T]; } catch { return []; }
  });
}

export class Store {
  installs: Record<string, InstallRow>;
  packages: Set<string>;
  records: StoredRecord[];
  candidates: CandidateRow[];
  official: Official;
  decisions: Decision[];

  constructor() {
    mkdirSync(path("records"), { recursive: true });
    mkdirSync(path("history"), { recursive: true });
    this.installs = readJson("installs.json", {});
    this.packages = new Set(existsSync(path("packages.txt")) ? readFileSync(path("packages.txt"), "utf8").split("\n").filter(Boolean) : []);
    this.records = readdirSync(path("records")).filter(name => name.endsWith(".jsonl")).sort()
      .flatMap(name => readLines<StoredRecord>(join("records", name)));
    this.candidates = readJson("candidates.json", []);
    this.official = readJson("official.json", { version: 0, items: [], parameters: {} });
    this.decisions = readLines("decisions.jsonl");
  }

  saveInstalls(): void { writeJson("installs.json", this.installs); }

  addPackage(installId: string, packageId: string, records: Record<string, unknown>[]): void {
    const receivedAt = new Date().toISOString();
    const rows = records.map(record => ({ installId, packageId, receivedAt, record }));
    if (rows.length) appendFileSync(path("records", `${receivedAt.slice(0, 7)}.jsonl`), rows.map(row => JSON.stringify(row)).join("\n") + "\n", "utf8");
    appendFileSync(path("packages.txt"), packageId + "\n", "utf8");
    this.packages.add(packageId);
    this.records.push(...rows);
  }

  saveCandidates(): void { writeJson("candidates.json", this.candidates); }

  publish(official: Official, decision: Omit<Decision, "at" | "version">): void {
    official.version = this.official.version + 1;
    official.publishedAt = new Date().toISOString();
    writeJson(join("history", `v${official.version}.json`), official);
    writeJson("official.json", official);
    this.official = official;
    this.decide(decision);
  }

  decide(decision: Omit<Decision, "at" | "version">): void {
    const row: Decision = { at: new Date().toISOString(), ...decision, version: this.official.version };
    appendFileSync(path("decisions.jsonl"), JSON.stringify(row) + "\n", "utf8");
    this.decisions.push(row);
  }
}
