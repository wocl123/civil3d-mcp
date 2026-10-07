// 가입 신청: 가입키 없이 설치한 PC(GitHub 릴리스 zip)가 등록을 신청하고, 검토자가 승인한다.
//   PC: POST /v1/join { installId, secret, computer, user } → 202 대기 / 200 승인(토큰) / 403 거절
//   검토자: 팔레트 /중앙 가입, 또는 서버 PC에서 npm run admin -- joins | approve <ID> | reject <ID>
// secret은 그 PC가 처음 신청할 때 만든 무작위 값이다. 같은 설치 ID로 다른 PC가 토큰을 받아 가지 못하게 한다(해시만 저장).
// PC·사용자 이름은 검토자가 누구인지 알아보는 데만 쓰고, 승인·거절하면 지운다(설치 ID와 이름을 잇는 기록을 남기지 않는다).

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { JoinRow, Store } from "./store.js";

export class JoinError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

const MAX_PENDING = 100;   // 대기 중인 신청 수(넘치면 새 신청을 받지 않는다)
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
// 화면에 보일 이름: 제어 문자를 빼고 64자까지.
const label = (value: unknown) => typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 64) || undefined : undefined;

// 신청(또는 결과 확인). 승인됐으면 새 토큰을 만들어 준다(응답을 잃어 다시 물어도 받을 수 있다).
export function requestJoin(store: Store, input: { installId?: unknown; secret?: unknown; computer?: unknown; user?: unknown }):
  { status: "pending" } | { status: "approved"; token: string } {
  if (typeof input.installId !== "string" || !/^[a-f\d]{16}$/.test(input.installId)) throw new JoinError("설치 ID가 맞지 않습니다.", 400);
  if (typeof input.secret !== "string" || !/^[a-f\d]{64}$/.test(input.secret)) throw new JoinError("신청 확인값이 맞지 않습니다.", 400);
  const now = new Date().toISOString();
  const row = store.joins[input.installId];

  if (!row) {
    if (Object.values(store.joins).filter(item => item.status === "pending").length >= MAX_PENDING)
      throw new JoinError("대기 중인 가입 신청이 너무 많습니다. 관리자에게 알려 주세요.", 429);
    store.joins[input.installId] = { installId: input.installId, secretHash: sha(input.secret), computer: label(input.computer), user: label(input.user),
      requestedAt: now, status: "pending" };
    store.saveJoins();
    return { status: "pending" };
  }
  if (!same(row.secretHash, sha(input.secret))) throw new JoinError("이 설치 ID는 다른 PC가 신청했습니다.", 403);
  if (row.status === "rejected") throw new JoinError("관리자가 가입 신청을 거절했습니다.", 403);
  if (row.status === "pending") return { status: "pending" };

  // 승인됨: 토큰을 만들어 해시만 저장한다(kit 가입과 같은 installs.json).
  const token = randomBytes(32).toString("hex");
  const today = now.slice(0, 10);
  store.installs[input.installId] = { installId: input.installId, tokenHash: sha(token), enrolledAt: store.installs[input.installId]?.enrolledAt ?? today, lastSeen: today };
  store.saveInstalls();
  return { status: "approved", token };
}

// 대기 중인 신청(오래된 것부터).
export const pendingJoins = (store: Store): JoinRow[] =>
  Object.values(store.joins).filter(item => item.status === "pending").sort((a, b) => a.requestedAt.localeCompare(b.requestedAt));

// 승인 / 거절. 이름은 지운다.
export function decideJoin(store: Store, installId: string, action: string): JoinRow {
  const row = store.joins[installId];
  if (!row || row.status !== "pending") throw new JoinError("대기 중인 가입 신청이 아닙니다(이미 처리했을 수 있습니다).", 404);
  if (action !== "approve" && action !== "reject") throw new JoinError("action은 approve 또는 reject입니다.", 400);
  const decided: JoinRow = { installId, secretHash: row.secretHash, requestedAt: row.requestedAt, status: action === "approve" ? "approved" : "rejected",
    decidedAt: new Date().toISOString() };
  store.joins[installId] = decided;
  store.saveJoins();
  return { ...row, ...decided, computer: row.computer, user: row.user };
}
