// 중앙 서버(central/src/server.ts) 호출.
// 모든 호출에 제한 시간이 있다. 서버가 꺼져 있어도 다음 동기화가 늦어질 뿐, 답변을 붙잡지 않는다.

import type { CentralSettings } from "../data/settings.js";

const TIMEOUT_MS = 15000;

// 중앙 서버 오류. status 0은 연결 자체가 안 됨.
export class CentralError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

// 요청 하나. token: 설치 인증, reviewerKey: 검토자 인증.
async function call<T>(url: string, path: string,
  init: { method?: string; token?: string; reviewerKey?: string; body?: unknown } = {}): Promise<T> {
  const headers: Record<string, string> = { "Accept": "application/json" };
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  if (init.token) headers["Authorization"] = `Bearer ${init.token}`;
  if (init.reviewerKey) headers["X-Reviewer-Key"] = init.reviewerKey;

  let response: Response;
  try {
    response = await fetch(url + path, {
      method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
  } catch (error) {
    throw new CentralError(`중앙 서버에 연결하지 못했습니다(${error instanceof Error ? error.message : String(error)}).`, 0);
  }

  const text = await response.text();
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
export const enroll = (url: string, installId: string, enrollKey: string) =>
  call<{ token: string }>(url, "/v1/enroll", { body: { installId, enrollKey } });

// 비식별 묶음 보내기 (같은 id는 서버가 한 번만 받는다).
export const sendPackage = (central: CentralSettings, body: unknown) =>
  call<{ accepted: boolean; duplicate?: boolean }>(central.url, "/v1/packages", { token: central.token, body });

// 지식 후보 보내기.
export const sendCandidates = (central: CentralSettings, candidates: unknown[]) =>
  call<{ accepted: number }>(central.url, "/v1/candidates", { token: central.token, body: { candidates } });

// 중앙 지식 받기. since 버전과 같으면 { unchanged: true }만 온다.
export const getOfficial = (central: CentralSettings, since: number) =>
  call<{ unchanged: true; version: number } | ({ unchanged?: false } & Official)>(
    central.url, `/v1/official?since=${since}`, { token: central.token });

// 검토자: 검토 목록.
export const getReview = (central: CentralSettings) =>
  call<{ items: ReviewItem[]; official: { version: number; items: Official["items"] } }>(
    central.url, "/v1/review", { token: central.token, reviewerKey: central.reviewerKey });

// 검토자: 승인 / 반려 / 철회.
export const decide = (central: CentralSettings,
  body: { id: string; decision: "approve" | "reject" | "retract"; reason?: string; content?: string }) =>
  call<{ version: number; decided: string }>(
    central.url, "/v1/review/decide", { token: central.token, reviewerKey: central.reviewerKey, body });

// 검토자: 보고 (실패·도구 통계, 수정 추적 결과).
export const getReport = (central: CentralSettings) =>
  call<Record<string, unknown>>(central.url, "/v1/report", { token: central.token, reviewerKey: central.reviewerKey });
