import { createHash, randomBytes } from "node:crypto";
import { readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { dataDir } from "../paths.js";
import { writeAtomic } from "../files.js";
import { install } from "../data/install.js";
import { privateTerms } from "../data/terms.js";
import { outboxDir } from "../sync/exporter.js";
import { jsonFiles } from "../drive/driveFolders.js";
import { validOfficial } from "../drive/memberSync.js";
import { applyOfficial } from "../knowledge/centralKnowledge.js";
import { unsentCandidates, markSubmitted } from "../knowledge/candidateStore.js";
import { blank, leak } from "../sync/privacy.js";
import type { SyncState } from "../sync/syncState.js";
import { productVersion } from "../version.js";
import { validIngestUrl } from "./config.js";

type Credentials = { schema: 1; installId: string; endpoint: string; token: string; registered?: boolean };
const MAX_BYTES = 2 * 1024 * 1024;
const credentialsFile = () => join(dataDir(), "state", "ingest-credentials.json");
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
async function credentials(endpoint: string): Promise<Credentials> {
  const { installId } = await install();
  let existingToken: string | undefined;
  const raw = await readFile(credentialsFile(), "utf8").catch(error => {
    if (error.code === "ENOENT") {
      return undefined;
    }

    throw error;
  });
  if (raw !== undefined) {
    const saved = JSON.parse(raw) as Credentials;
    if (saved.schema !== 1 || saved.installId !== installId || !/^[a-f\d]{64}$/.test(saved.token)) {
      throw new Error("자동 전송 등록 정보가 손상되었습니다. 로컬 데이터는 보존됩니다.");
    }

    if (saved.endpoint === endpoint) {
      return saved;
    }

    existingToken = saved.token;
  }

  const fresh: Credentials = { schema: 1, installId, endpoint, token: existingToken ?? randomBytes(32).toString("hex") };
  await writeAtomic(credentialsFile(), JSON.stringify(fresh));
  return fresh;
}

async function request(
  auth: Credentials, action: string, extra: Record<string, unknown> = {}
): Promise<Record<string, unknown>> {
  if (!validIngestUrl(auth.endpoint)) {
    throw new Error("관리자 자동 수신 주소가 올바르지 않습니다.");
  }

  const text = JSON.stringify({
    schema: 1,
    action,
    installId: auth.installId,
    token: auth.token,
    appVersion: productVersion,
    ...extra
  });
  if (Buffer.byteLength(text) > MAX_BYTES) {
    throw new Error("자동 전송 묶음이 크기 제한을 초과했습니다.");
  }

  const endpoint = process.env.MY_CIVIL3D_INGEST_TEST_URL ?? auth.endpoint;
  if (process.env.MY_CIVIL3D_INGEST_TEST_URL && !/^http:\/\/127\.0\.0\.1:\d+\//.test(endpoint)) {
    throw new Error("수신 테스트 주소는 로컬 호스트만 허용됩니다.");
  }

  // Apps Script ContentService redirects after POST. The redirect contains no body/token.
  const response = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: text,
    redirect: "follow", signal: AbortSignal.timeout(60000) });
  if (!response.ok || !response.body) {
    throw new Error(`자동 수신 연결 실패(HTTP ${response.status})`);
  }

  const reader = response.body.getReader(), parts: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      size += value.byteLength;
      if (size > 512 * 1024) {
        await reader.cancel();
        throw new Error("자동 수신 응답 크기 초과");
      }

      parts.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  let result: Record<string, unknown>;
  try {
    result = JSON.parse(Buffer.concat(parts, size).toString("utf8")) as Record<string, unknown>;
  } catch {
    throw new Error("수신 웹앱 응답이 JSON이 아닙니다. 관리자의 웹앱 배포 권한을 확인하세요.");
  }

  if (result.schema !== 1 || result.installId !== auth.installId || result.ok !== true) {
    throw new Error("자동 수신 거절: " + String(result.code ?? "잘못된 수신 확인"));
  }

  return result;
}

export async function webMemberSync(
  endpoint: string, state: SyncState
): Promise<{ sent: number; candidates: number; official?: number }> {
  const auth = await credentials(endpoint);
  if (!auth.registered) {
    await request(auth, "register");
    auth.registered = true;
    await writeAtomic(credentialsFile(), JSON.stringify(auth));
  }

  const result = { sent: 0, candidates: 0, official: state.officialVersion };
  // Bound one pass; the next scheduled pass resumes the remaining queue.
  for (const name of (await jsonFiles(outboxDir("pending"))).slice(0, 20)) {
    const file = join(outboxDir("pending"), name);
    if ((await stat(file)).size > MAX_BYTES - 4096) {
      throw new Error("전송 대기 묶음이 크기 제한을 초과했습니다.");
    }

    const text = await readFile(file, "utf8"), item = JSON.parse(text);
    if (item.installId !== auth.installId || item.packageId + ".json" !== name) {
      throw new Error("전송 묶음의 설치 ID/파일명이 일치하지 않습니다.");
    }

    const reason = leak(text, await privateTerms());
    if (reason) {
      await writeAtomic(join(outboxDir("blocked"), name), JSON.stringify({ reason, blockedAt: new Date().toISOString(), package: item }));
      await rm(file, { force: true });
      continue;
    }

    const digest = sha256(JSON.stringify(item));
    const receipt = await request(auth, "package", { package: item });
    if (receipt.packageId !== item.packageId || receipt.sha256 !== digest) {
      throw new Error("수신 확인의 묶음 ID/해시가 맞지 않습니다. 재시도용 파일을 보존했습니다.");
    }

    await rm(file, { force: true });
    result.sent++;
    // Persist each confirmed receipt so a later failure cannot erase successful counts.
    state.sentPackages = (state.sentPackages ?? 0) + 1;
    state.lastPush = new Date().toISOString();
    await (await import("../sync/syncState.js")).saveState(state);
  }

  const terms = await privateTerms();
  const ready = (await unsentCandidates()).slice(0, 50).map(item => ({
    localId: item.id, title: blank(item.title, terms), content: blank(item.content, terms),
    ...(item.parameter ? { parameter: item.parameter } : {}), provider: item.provider,
    at: item.at.slice(0, 10), localStatus: item.status
  })).filter(item => !leak(JSON.stringify(item), terms));
  if (ready.length) {
    const receipt = await request(auth, "candidates", { candidates: ready });
    const expected = ready.map(item => item.localId).sort();
    if (receipt.sha256 !== sha256(JSON.stringify(ready)) || !Array.isArray(receipt.candidateIds)
      || JSON.stringify([...receipt.candidateIds].sort()) !== JSON.stringify(expected)) {
      throw new Error("지식 후보 수신 확인이 맞지 않습니다.");
    }

    await markSubmitted(expected);
    result.candidates = ready.length;
    state.sentCandidates = (state.sentCandidates ?? 0) + ready.length;
    state.lastPush = new Date().toISOString();
    await (await import("../sync/syncState.js")).saveState(state);
  }

  const received = await request(auth, "pull");
  if (received.official !== undefined) {
    const official = validOfficial(received.official);
    if (!official) {
      throw new Error("승인 지식 응답이 올바르지 않습니다.");
    }

    if (official.version > (state.officialVersion ?? 0)) {
      await applyOfficial(official);
    }

    state.officialVersion = Math.max(state.officialVersion ?? 0, official.version);
    result.official = state.officialVersion;
  }

  state.lastPull = new Date().toISOString();
  return result;
}
