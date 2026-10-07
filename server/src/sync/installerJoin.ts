// 설치 프로그램이 남긴 중앙 서버 가입 요청(data/central-join.json: 주소, 인증서 지문, 가입키)을 처리한다.
// 온라인 설치(설치.bat + server.json)를 한 PC는 /중앙 연결을 따로 입력하지 않아도 연결된다.
//   가입키가 있으면(관리자가 준 설치 묶음): 바로 등록한다.
//   가입키가 없으면(GitHub 릴리스 zip, /중앙 신청): 가입을 신청하고, 검토자가 승인할 때까지 1분마다 확인한다.
//     신청에는 PC 이름과 Windows 사용자 이름이 들어간다(검토자가 알아보도록). 중앙은 승인·거절하면 지운다.
// 등록하면 토큰만 settings.json에 저장하고 요청 파일은 지운다. 이미 연결된 PC면 그냥 지운다.

import { randomBytes } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { hostname, userInfo } from "node:os";
import { join } from "node:path";
import { install } from "../data/install.js";
import { centralUrl, loadSettings, saveSettings } from "../data/settings.js";
import { writeAtomic } from "../files.js";
import { dataDir } from "../paths.js";
import { CentralError, enroll, normalizeFingerprint, requestJoin } from "./centralClient.js";

type JoinFile = { url?: unknown; enrollKey?: unknown; certSha256?: unknown; secret?: unknown; requestedAt?: unknown; rejected?: unknown; lastError?: unknown };

const file = () => join(dataDir(), "central-join.json");

async function readJoin(): Promise<JoinFile | undefined> {
  try {
    return JSON.parse((await readFile(file(), "utf8")).replace(/^﻿/, "")) as JoinFile;
  } catch {
    return undefined;   // 요청 없음
  }
}

// /중앙 표시용: 가입 신청 상태(가입키 없는 신청만).
export async function joinStatus(): Promise<{ url: string; state: "pending" | "rejected"; requestedAt?: string; lastError?: string } | undefined> {
  const request = await readJoin();
  if (!request || typeof request.url !== "string" || (typeof request.enrollKey === "string" && request.enrollKey)) return undefined;
  return {
    url: request.url,
    state: request.rejected === true ? "rejected" : "pending",
    ...(typeof request.requestedAt === "string" ? { requestedAt: request.requestedAt } : {}),
    ...(typeof request.lastError === "string" ? { lastError: request.lastError } : {})
  };
}

// /중앙 신청 <주소> [지문]: 가입키 없이 신청 파일을 만든다(다음 확인 때 보낸다).
export async function saveJoinRequest(url: string, certSha256?: string): Promise<void> {
  await writeAtomic(file(), JSON.stringify({ url, ...(certSha256 ? { certSha256 } : {}) }, null, 1));
}

// 요청 처리 한 번. 연결되면 true.
export async function joinFromInstaller(): Promise<boolean> {
  const request = await readJoin();
  if (!request) return false;
  const settings = await loadSettings();
  const url = centralUrl(String(request.url ?? ""));
  if (settings.central || !url) {
    await rm(file(), { force: true });
    return false;
  }
  if (request.rejected === true) return false;   // 거절됨: 다시 묻지 않는다(/중앙 신청으로 새로 신청)
  const pin = typeof request.certSha256 === "string" ? normalizeFingerprint(request.certSha256) : undefined;
  const connect = async (token: string) => {
    settings.central = { url, token, ...(pin ? { certSha256: pin } : {}), enabled: true, enrolledAt: new Date().toISOString() };
    await saveSettings(settings);
    await rm(file(), { force: true });
    return true;
  };

  // 가입키가 있으면 바로 등록
  if (typeof request.enrollKey === "string" && request.enrollKey) {
    try {
      return await connect((await enroll(url, (await install()).installId, request.enrollKey, pin)).token);
    } catch (error) {
      // 가입키가 틀렸으면 다시 해도 안 되므로 지운다. 서버에 닿지 않았으면 다음 동기화 때 다시 한다.
      if (error instanceof CentralError && error.status === 403) await rm(file(), { force: true });
      process.stderr.write(`MyCivil3DMcp central join from installer failed: ${error instanceof Error ? error.message : String(error)}\n`);
      return false;
    }
  }

  // 가입키가 없으면 신청하고 승인을 기다린다. secret은 처음 한 번 만들어 이 파일에 둔다(승인된 토큰을 이 PC만 받게).
  const secret = typeof request.secret === "string" && /^[a-f\d]{64}$/.test(request.secret) ? request.secret : randomBytes(32).toString("hex");
  const save = (extra: Partial<JoinFile>) => writeAtomic(file(), JSON.stringify({ ...request, secret, ...extra }, null, 1));
  try {
    const result = await requestJoin(url, pin, { installId: (await install()).installId, secret, computer: hostname(), user: userInfo().username });
    if (result.status === "approved") return await connect(result.token);
    if (request.secret !== secret || request.lastError || !request.requestedAt)
      await save({ requestedAt: typeof request.requestedAt === "string" ? request.requestedAt : new Date().toISOString(), lastError: undefined });
    return false;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await save(error instanceof CentralError && error.status === 403 ? { rejected: true, lastError: message } : { lastError: message });
    process.stderr.write(`MyCivil3DMcp central join request failed: ${message}\n`);
    return false;
  }
}
