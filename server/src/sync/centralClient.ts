// 중앙 서버(central/src/server.ts) 호출.
// 모든 호출에 제한 시간이 있다. 서버가 꺼져 있어도 다음 동기화가 늦어질 뿐, 답변을 붙잡지 않는다.
// HTTPS: 서버는 사내용 자체 인증서를 쓰므로 공용 인증기관 대신 인증서 지문(SHA-256, settings의 certSha256)을 고정해 믿는다.
//   TLS 연결을 먼저 맺고 지문을 확인한 뒤에만 요청(토큰·키)을 보낸다. 지문이 다르면 아무것도 보내지 않는다.
// HTTP는 이 PC 안(127.0.0.1, localhost)만 허용한다.

import { request as httpsRequest } from "node:https";
import { connect, type TLSSocket } from "node:tls";
import { isIP } from "node:net";
import type { CentralSettings } from "../data/settings.js";

const TIMEOUT_MS = 15000;

// 중앙 서버 오류. status 0은 연결 자체가 안 됨.
export class CentralError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export const normalizeFingerprint = (text: string) => text.replace(/[:\s]/g, "").toLowerCase();
const loopback = (host: string) => host === "127.0.0.1" || host === "localhost" || host === "[::1]" || host === "::1";

// 지문을 확인한 TLS 연결. 맞지 않으면 아무것도 보내기 전에 끊는다.
function pinnedSocket(url: URL, pin: string): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const socket = connect({ host, port: Number(url.port || 443), servername: isIP(host) ? undefined : host, rejectUnauthorized: false });
    const fail = (error: Error) => { socket.destroy(); reject(error); };
    socket.setTimeout(TIMEOUT_MS, () => fail(new CentralError("중앙 서버 연결 시간이 지났습니다.", 0)));
    socket.once("error", error => fail(new CentralError(`중앙 서버에 연결하지 못했습니다(${error.message}).`, 0)));
    socket.once("secureConnect", () => {
      const actual = normalizeFingerprint(socket.getPeerCertificate().fingerprint256 ?? "");
      if (actual !== pin) fail(new CentralError("중앙 서버의 인증서가 등록된 것과 다릅니다. 다른 서버이거나 통신이 가로채졌을 수 있어 연결하지 않았습니다. 관리자에게 확인하세요.", 0));
      else { socket.setTimeout(0); resolve(socket); }
    });
  });
}

type Reply = { ok: boolean; status: number; data: Buffer };

async function send(url: URL, method: string, headers: Record<string, string>, body: string | undefined, pin?: string): Promise<Reply> {
  if (url.protocol === "http:") {
    if (!loopback(url.hostname)) throw new CentralError("다른 PC의 중앙 서버는 HTTPS로만 연결합니다. 주소를 https:// 로 바꾸세요.", 0);
    let response: Response;
    try {
      response = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (error) {
      throw new CentralError(`중앙 서버에 연결하지 못했습니다(${error instanceof Error ? error.message : String(error)}).`, 0);
    }
    return { ok: response.ok, status: response.status, data: Buffer.from(await response.arrayBuffer()) };
  }
  if (url.protocol !== "https:") throw new CentralError("중앙 서버 주소는 https:// 여야 합니다.", 0);
  if (!pin || !/^[a-f\d]{64}$/.test(pin)) throw new CentralError("중앙 서버 인증서 지문이 없습니다. /중앙 연결 <주소> <가입키> <인증서지문> 으로 다시 연결하세요.", 0);
  const socket = await pinnedSocket(url, pin);
  return await new Promise<Reply>((resolve, reject) => {
    const req = httpsRequest(url, { method, headers: { ...headers, ...(body ? { "Content-Length": String(Buffer.byteLength(body)) } : {}) },
      createConnection: () => socket }, response => {   // agent를 주지 않아야 이 연결(지문 확인됨)을 쓴다
      const chunks: Buffer[] = [];
      response.on("data", chunk => chunks.push(chunk as Buffer));
      response.on("end", () => resolve({ ok: (response.statusCode ?? 0) < 400, status: response.statusCode ?? 0, data: Buffer.concat(chunks) }));
      response.on("error", error => reject(new CentralError(`중앙 서버 응답을 받지 못했습니다(${error.message}).`, 0)));
    });
    req.setTimeout(TIMEOUT_MS, () => req.destroy(new Error("timeout")));
    req.on("error", error => reject(new CentralError(`중앙 서버에 연결하지 못했습니다(${error.message}).`, 0)));
    req.end(body);
  });
}

// 요청 하나. token: 설치 인증, reviewerKey: 검토자 인증, pin: HTTPS 인증서 지문.
async function call<T>(url: string, path: string,
  init: { method?: string; token?: string; reviewerKey?: string; body?: unknown; pin?: string } = {}): Promise<T> {
  const headers: Record<string, string> = { "Accept": "application/json" };
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  if (init.token) headers["Authorization"] = `Bearer ${init.token}`;
  if (init.reviewerKey) headers["X-Reviewer-Key"] = init.reviewerKey;

  const response = await send(new URL(url + path), init.method ?? (init.body === undefined ? "GET" : "POST"), headers,
    init.body === undefined ? undefined : JSON.stringify(init.body), init.pin && normalizeFingerprint(init.pin));
  const text = response.data.toString("utf8");
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { error: text.slice(0, 200) };
  }
  if (!response.ok) throw new CentralError(String((parsed as { error?: unknown }).error ?? `HTTP ${response.status}`), response.status);
  return parsed as T;
}

// 중앙 지식: 승인된 항목과 설정값.
export type Official = {
  version: number;
  publishedAt?: string;
  items: { id: string; content: string; approvedAt: string; parameter?: { key: string; value: number } }[];
  parameters: Record<string, number>;
};

// 검토 목록의 항목 하나 (후보 묶음 또는 통계 제안).
export type ReviewItem = {
  id: string;
  kind: "candidate" | "parameter";
  content: string;
  parameter?: { key: string; value: number };
  support: { installs: number; cases: number };   // 몇 곳의 설치에서, 몇 건
  evidence: string[];
};

// 가입키로 등록하고 토큰을 받는다.
export const enroll = (url: string, installId: string, enrollKey: string, pin?: string) =>
  call<{ token: string }>(url, "/v1/enroll", { body: { installId, enrollKey }, pin });

// 비식별 묶음 보내기 (같은 id는 서버가 한 번만 받는다).
export const sendPackage = (central: CentralSettings, body: unknown) =>
  call<{ accepted: boolean; duplicate?: boolean }>(central.url, "/v1/packages", { token: central.token, body, pin: central.certSha256 });

// 지식 후보 보내기.
export const sendCandidates = (central: CentralSettings, candidates: unknown[]) =>
  call<{ accepted: number }>(central.url, "/v1/candidates", { token: central.token, body: { candidates }, pin: central.certSha256 });

// 중앙 지식 받기. since 버전과 같으면 { unchanged: true }만 온다.
export const getOfficial = (central: CentralSettings, since: number) =>
  call<{ unchanged: true; version: number } | ({ unchanged?: false } & Official)>(
    central.url, `/v1/official?since=${since}`, { token: central.token, pin: central.certSha256 });

// 검토자: 검토 목록.
export const getReview = (central: CentralSettings) =>
  call<{ items: ReviewItem[]; official: { version: number; items: Official["items"] } }>(
    central.url, "/v1/review", { token: central.token, reviewerKey: central.reviewerKey, pin: central.certSha256 });

// 검토자: 승인 / 반려 / 철회.
export const decide = (central: CentralSettings,
  body: { id: string; decision: "approve" | "reject" | "retract"; reason?: string; content?: string }) =>
  call<{ version: number; decided: string }>(
    central.url, "/v1/review/decide", { token: central.token, reviewerKey: central.reviewerKey, body, pin: central.certSha256 });

// 검토자: 보고 (실패·도구 통계, 수정 추적 결과).
export const getReport = (central: CentralSettings) =>
  call<Record<string, unknown>>(central.url, "/v1/report", { token: central.token, reviewerKey: central.reviewerKey, pin: central.certSha256 });

// 배포 중인 버전(중앙 서버 release 명령으로 지정한 것). 없으면 { none: true }.
export type PublishedRelease = { none?: true; version?: string; sha256?: string; size?: number; minVersion?: string };
export const getRelease = (central: CentralSettings) =>
  call<PublishedRelease>(central.url, "/v1/release", { token: central.token, pin: central.certSha256 });

// 배포 zip 받기(그 버전이 아직 배포 중일 때만 서버가 준다). 크기·해시는 부른 쪽이 확인한다.
export async function downloadRelease(central: CentralSettings, version: string): Promise<Buffer> {
  const response = await send(new URL(`${central.url}/v1/release/download?version=${encodeURIComponent(version)}`), "GET",
    { Authorization: `Bearer ${central.token}` }, undefined, central.certSha256 && normalizeFingerprint(central.certSha256));
  if (!response.ok) throw new CentralError(`설치 파일을 받지 못했습니다(HTTP ${response.status}).`, response.status);
  return response.data;
}

// 검토자: 문제 사례(👎·되돌림·실패가 있었던 질문, 내용 포함).
export type CaseTriage = { status: "todo" | "done" | "discarded"; category?: string; note?: string; version?: string; decidedAt: string };
export type ProblemCase = {
  key: string; id: string; at: string; triage?: CaseTriage; appVersion?: string; provider?: string; model?: string; errorKind?: string;
  question?: string; answer?: string; signals: string[]; feedback: string[];
  changes: { state: string; title?: string; labels?: string }[]; tools: string[];
};
export const getCases = (central: CentralSettings, status = "new") =>
  call<{ cases: ProblemCase[] }>(central.url, `/v1/review/cases?status=${status}`, { token: central.token, reviewerKey: central.reviewerKey, pin: central.certSha256 });

// 검토자: 한 바퀴 정리(분류 전·할 일 사례만 남기고 나머지 내용 삭제).
export const cleanupContent = (central: CentralSettings) =>
  call<{ scrubbed: number; kept: number }>(central.url, "/v1/review/cleanup", { token: central.token, reviewerKey: central.reviewerKey, body: {}, pin: central.certSha256 });

// 검토자: 사례 분류. action: todo(처리, category 필수) / done(처리 끝) / discard(버림: 내용 삭제) / reopen
export const decideCase = (central: CentralSettings, body: { key: string; action: string; category?: string; note?: string; version?: string }) =>
  call<{ triage: CaseTriage | null }>(central.url, "/v1/review/cases/decide", { token: central.token, reviewerKey: central.reviewerKey, body, pin: central.certSha256 });

// 가입 신청(가입키 없이 설치한 PC). 승인되면 토큰이 온다. 거절이면 CentralError(403).
export const requestJoin = (url: string, pin: string | undefined, body: { installId: string; secret: string; computer: string; user: string }) =>
  call<{ status: "pending" } | { status: "approved"; token: string }>(url, "/v1/join", { body, pin });

// 검토자: 대기 중인 가입 신청, 승인 / 거절.
export type JoinRequest = { installId: string; computer?: string; user?: string; requestedAt: string };
export const getJoins = (central: CentralSettings) =>
  call<{ joins: JoinRequest[] }>(central.url, "/v1/review/joins", { token: central.token, reviewerKey: central.reviewerKey, pin: central.certSha256 });
export const decideJoin = (central: CentralSettings, installId: string, action: "approve" | "reject") =>
  call<{ installId: string; status: string; computer?: string; user?: string }>(central.url, "/v1/review/joins/decide",
    { token: central.token, reviewerKey: central.reviewerKey, body: { installId, action }, pin: central.certSha256 });
