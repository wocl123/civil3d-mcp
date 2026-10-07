// 설치 프로그램이 남긴 중앙 서버 가입 요청(data/central-join.json: 주소, 가입키)을 처리한다.
// 온라인 설치(설치.bat + server.json)를 한 PC는 /중앙 연결을 따로 입력하지 않아도 연결된다.
// 등록하면 토큰만 settings.json에 저장하고 요청 파일(가입키)은 지운다. 이미 연결된 PC면 그냥 지운다.

import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { install } from "../data/install.js";
import { centralUrl, loadSettings, saveSettings } from "../data/settings.js";
import { dataDir } from "../paths.js";
import { CentralError, enroll, normalizeFingerprint } from "./centralClient.js";

export async function joinFromInstaller(): Promise<boolean> {
  const file = join(dataDir(), "central-join.json");
  let request: { url?: unknown; enrollKey?: unknown; certSha256?: unknown };
  try {
    request = JSON.parse((await readFile(file, "utf8")).replace(/^﻿/, "")) as typeof request;
  } catch {
    return false;   // 요청 없음
  }
  const settings = await loadSettings();
  const url = centralUrl(String(request.url ?? ""));
  if (settings.central || !url || typeof request.enrollKey !== "string" || !request.enrollKey) {
    await rm(file, { force: true });
    return false;
  }
  try {
    const pin = typeof request.certSha256 === "string" ? normalizeFingerprint(request.certSha256) : undefined;
    const { token } = await enroll(url, (await install()).installId, request.enrollKey, pin);
    settings.central = { url, token, ...(pin ? { certSha256: pin } : {}), enabled: true, enrolledAt: new Date().toISOString() };
    await saveSettings(settings);
    await rm(file, { force: true });
    return true;
  } catch (error) {
    // 가입키가 틀렸으면 다시 해도 안 되므로 지운다. 서버에 닿지 않았으면 다음 동기화 때 다시 한다.
    if (error instanceof CentralError && error.status === 403) await rm(file, { force: true });
    process.stderr.write(`MyCivil3DMcp central join from installer failed: ${error instanceof Error ? error.message : String(error)}\n`);
    return false;
  }
}
