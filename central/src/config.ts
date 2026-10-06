// 중앙 서버 설정. 파일 두 개로 정한다 (docs/중앙서버_설정_가이드.md).
//   central/settings.json   어디서 듣고(host, port) 데이터를 어디 둘지(dataDir).
//                           서버를 운영하는 사람이 고친다. 처음 시작할 때 기본값으로 만들어진다.
//   <dataDir>/config.json   키와 통계 기준. 처음 시작할 때 만들어지고 데이터와 함께 있으므로,
//                           데이터 폴더를 다른 PC로 옮기면 키도 함께 옮겨진다.
// 가입키는 모든 사용자에게(/중앙 연결 <주소> <가입키>), 검토자 키는 검토자에게만(/중앙 검토자 <키>) 준다.
// 통계 기준은 여러 설치의 패턴을 언제 제안으로 올릴지 정한다(review.ts).
// CENTRAL_HOST, CENTRAL_PORT, CENTRAL_DATA_DIR 환경 변수가 설정 파일보다 우선한다(테스트가 쓴다).

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type Settings = { host: string; port: number; dataDir: string };

export type Config = {
  schema: 1;
  enrollKey: string;     // 가입키
  reviewerKey: string;   // 검토자 키
  minInstalls: number;   // 설정값 제안에 필요한 서로 다른 설치 수
  minCases: number;      // 설정값 제안에 필요한 수정 건수
  minShare: number;      // 해당 수정 중 같은 방향인 비율
  reportDays: number;    // /검토 보고 기간(일)
};

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const settingsFile = join(appRoot, "settings.json");
const DEFAULTS: Settings = { host: "127.0.0.1", port: 48950, dataDir: "data" };

// 메모장이 붙이는 UTF-8 BOM 을 떼고 JSON으로 읽는다.
const readJsonText = (file: string) => readFileSync(file, "utf8").replace(/^﻿/, "");

function loadSettings(): Settings {
  // 1) 설정 파일 (없으면 기본값으로 만든다. 테스트처럼 데이터 폴더를 환경 변수로 주면 만들지 않는다.)
  let saved: Partial<Settings> = {};
  if (existsSync(settingsFile)) {
    try {
      saved = JSON.parse(readJsonText(settingsFile)) as Partial<Settings>;
    } catch (error) {
      throw new Error(`${settingsFile}을(를) 읽지 못했습니다. JSON 형식을 확인하세요. (${String(error)})`);
    }
  } else if (!process.env.CENTRAL_DATA_DIR) {
    writeFileSync(settingsFile, JSON.stringify(DEFAULTS, null, 2) + "\n", "utf8");
  }

  // 2) 환경 변수 > 설정 파일 > 기본값
  const settings: Settings = {
    host: process.env.CENTRAL_HOST ?? saved.host ?? DEFAULTS.host,
    port: Number(process.env.CENTRAL_PORT ?? saved.port ?? DEFAULTS.port),
    dataDir: process.env.CENTRAL_DATA_DIR ?? saved.dataDir ?? DEFAULTS.dataDir
  };
  if (!Number.isInteger(settings.port) || settings.port < 1 || settings.port > 65535)
    throw new Error(`port는 1~65535 사이의 정수여야 합니다(지금 ${settings.port}).`);
  if (typeof settings.host !== "string" || !settings.host) throw new Error("host가 비어 있습니다.");

  // 상대 경로 데이터 폴더는 central/ 기준.
  return { ...settings, dataDir: isAbsolute(settings.dataDir) ? settings.dataDir : join(appRoot, settings.dataDir) };
}

const settings = loadSettings();
export const { host, port, dataDir } = settings;

// 키와 기준을 읽는다. 없으면 무작위 키로 새로 만든다(이 파일은 다른 사람이 못 읽게 0600).
export function loadConfig(): Config {
  mkdirSync(dataDir, { recursive: true });
  const file = join(dataDir, "config.json");
  try {
    const parsed = JSON.parse(readJsonText(file)) as Config;
    if (parsed.schema === 1 && parsed.enrollKey && parsed.reviewerKey) return parsed;
  } catch {
    // 아래에서 만든다.
  }
  const config: Config = {
    schema: 1,
    enrollKey: randomBytes(12).toString("hex"),
    reviewerKey: randomBytes(24).toString("hex"),
    minInstalls: 2,
    minCases: 5,
    minShare: 0.8,
    reportDays: 30
  };
  writeFileSync(file, JSON.stringify(config, null, 1), { encoding: "utf8", mode: 0o600 });
  process.stderr.write(`New central server keys in ${file}\n`);
  return config;
}
