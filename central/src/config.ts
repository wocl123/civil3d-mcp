import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Two files set up the central server (docs/중앙서버_설정_가이드.md):
//   central/settings.json   where it listens and keeps its data; the person running the
//                           server edits it (made with defaults on first start)
//   <dataDir>/config.json   its keys and thresholds; made on first start and kept with the
//                           data, so moving the data folder to another PC moves the keys too
// The enrol key goes to every user (/중앙 연결 <주소> <가입키>), the reviewer key only to
// the reviewer (/중앙 검토자 <키>). Thresholds decide when patterns across installs become
// proposals (review.ts). CENTRAL_HOST, CENTRAL_PORT, and CENTRAL_DATA_DIR override the
// settings file (tests use them).
export type Settings = { host: string; port: number; dataDir: string };
export type Config = {
  schema: 1;
  enrollKey: string; reviewerKey: string;
  minInstalls: number; minCases: number; minShare: number; reportDays: number;
};

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const settingsFile = join(appRoot, "settings.json");
const DEFAULTS: Settings = { host: "127.0.0.1", port: 48950, dataDir: "data" };

function loadSettings(): Settings {
  let saved: Partial<Settings> = {};
  if (existsSync(settingsFile)) {
    try { saved = JSON.parse(readFileSync(settingsFile, "utf8").replace(/^﻿/, "")) as Partial<Settings>; }
    catch (error) { throw new Error(`${settingsFile}을(를) 읽지 못했습니다. JSON 형식을 확인하세요. (${String(error)})`); }
  } else if (!process.env.CENTRAL_DATA_DIR) {
    writeFileSync(settingsFile, JSON.stringify(DEFAULTS, null, 2) + "\n", "utf8");
  }
  const settings: Settings = {
    host: process.env.CENTRAL_HOST ?? saved.host ?? DEFAULTS.host,
    port: Number(process.env.CENTRAL_PORT ?? saved.port ?? DEFAULTS.port),
    dataDir: process.env.CENTRAL_DATA_DIR ?? saved.dataDir ?? DEFAULTS.dataDir
  };
  if (!Number.isInteger(settings.port) || settings.port < 1 || settings.port > 65535)
    throw new Error(`port는 1~65535 사이의 정수여야 합니다(지금 ${settings.port}).`);
  if (typeof settings.host !== "string" || !settings.host) throw new Error("host가 비어 있습니다.");
  return { ...settings, dataDir: isAbsolute(settings.dataDir) ? settings.dataDir : join(appRoot, settings.dataDir) };
}

const settings = loadSettings();
export const { host, port, dataDir } = settings;

export function loadConfig(): Config {
  mkdirSync(dataDir, { recursive: true });
  const file = join(dataDir, "config.json");
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8").replace(/^﻿/, "")) as Config;
    if (parsed.schema === 1 && parsed.enrollKey && parsed.reviewerKey) return parsed;
  } catch { /* Made below. */ }
  const config: Config = {
    schema: 1, enrollKey: randomBytes(12).toString("hex"), reviewerKey: randomBytes(24).toString("hex"),
    minInstalls: 2, minCases: 5, minShare: 0.8, reportDays: 30
  };
  writeFileSync(file, JSON.stringify(config, null, 1), { encoding: "utf8", mode: 0o600 });
  process.stderr.write(`New central server keys in ${file}\n`);
  return config;
}
