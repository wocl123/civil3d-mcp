import type { CentralSettings } from "../data/settings.js";

// Calls to the central server (central/src/server.ts). Every call has a time limit, so a
// server that is down only delays the next sync; it never holds up an answer.
const TIMEOUT_MS = 15000;

export class CentralError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

async function call<T>(url: string, path: string, init: { method?: string; token?: string; reviewerKey?: string; body?: unknown } = {}): Promise<T> {
  const headers: Record<string, string> = { "Accept": "application/json" };
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  if (init.token) headers["Authorization"] = `Bearer ${init.token}`;
  if (init.reviewerKey) headers["X-Reviewer-Key"] = init.reviewerKey;
  let response: Response;
  try {
    response = await fetch(url + path, {
      method: init.method ?? (init.body === undefined ? "GET" : "POST"), headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body), signal: AbortSignal.timeout(TIMEOUT_MS)
    });
  } catch (error) {
    throw new CentralError(`중앙 서버에 연결하지 못했습니다(${error instanceof Error ? error.message : String(error)}).`, 0);
  }
  const text = await response.text();
  let parsed: unknown;
  try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { error: text.slice(0, 200) }; }
  if (!response.ok) throw new CentralError(String((parsed as { error?: unknown }).error ?? `HTTP ${response.status}`), response.status);
  return parsed as T;
}

export type Official = {
  version: number; publishedAt?: string;
  items: { id: string; content: string; approvedAt: string; parameter?: { key: string; value: number } }[];
  parameters: Record<string, number>;
};

export type ReviewItem = {
  id: string; kind: "candidate" | "parameter";
  content: string; parameter?: { key: string; value: number };
  support: { installs: number; cases: number }; evidence: string[];
};

export const enroll = (url: string, installId: string, enrollKey: string) =>
  call<{ token: string }>(url, "/v1/enroll", { body: { installId, enrollKey } });

export const sendPackage = (central: CentralSettings, body: unknown) =>
  call<{ accepted: boolean; duplicate?: boolean }>(central.url, "/v1/packages", { token: central.token, body });

export const sendCandidates = (central: CentralSettings, candidates: unknown[]) =>
  call<{ accepted: number }>(central.url, "/v1/candidates", { token: central.token, body: { candidates } });

export const getOfficial = (central: CentralSettings, since: number) =>
  call<{ unchanged: true; version: number } | ({ unchanged?: false } & Official)>(central.url, `/v1/official?since=${since}`, { token: central.token });

export const getReview = (central: CentralSettings) =>
  call<{ items: ReviewItem[]; official: { version: number; items: Official["items"] } }>(central.url, "/v1/review", { token: central.token, reviewerKey: central.reviewerKey });

export const decide = (central: CentralSettings, body: { id: string; decision: "approve" | "reject" | "retract"; reason?: string; content?: string }) =>
  call<{ version: number; decided: string }>(central.url, "/v1/review/decide", { token: central.token, reviewerKey: central.reviewerKey, body });

export const getReport = (central: CentralSettings) =>
  call<Record<string, unknown>>(central.url, "/v1/report", { token: central.token, reviewerKey: central.reviewerKey });
