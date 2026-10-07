// my-civil3d-mcp 설치들을 위한 중앙 서버 (docs/데이터관리_설계.md §6).
// 비식별 기록과 지식 후보를 받고, 여러 설치가 같은 것을 가리키면 검토자에게 보여 주고,
// 검토자가 승인한 지식을 내려 준다.
// HTTP로만 뜬다. 사설망 안에서 쓰거나, 인터넷에 열 때는 HTTPS 프록시를 앞에 둔다.
//
// API
//   GET  /v1/health                상태 (인증 없음)
//   POST /v1/enroll                가입키로 등록 → 토큰 (인증 없음, IP당 분당 60회)
//   POST /v1/packages              비식별 묶음                   (설치 토큰)
//   POST /v1/candidates            지식 후보                     (설치 토큰)
//   GET  /v1/official?since=n      승인 지식과 설정값            (설치 토큰)
//   GET  /v1/review                검토 목록                     (설치 토큰 + 검토자 키)
//   POST /v1/review/decide         승인 / 반려 / 철회            (설치 토큰 + 검토자 키)
//   GET  /v1/report                보고                          (설치 토큰 + 검토자 키)
//   GET  /v1/release               배포 중인 버전·SHA-256·크기   (가입키 또는 설치 토큰)
//   GET  /v1/release/download      배포 zip                       (가입키 또는 설치 토큰)
//   배포 버전은 release.ts 명령으로 받아 두고 지정한다(releases.ts).

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { dataDir, host, loadConfig, port, settingsFile } from "./config.js";
import { decide, groupKey, report, ReviewError, reviewItems } from "./review.js";
import { current, releaseFile } from "./releases.js";
import { Store } from "./store.js";
import { Invalid, validCandidates, validPackage } from "./validate.js";

const config = loadConfig();
const store = new Store();
const MAX_BODY = 1024 * 1024;     // 요청 본문 1 MB까지
const RATE_PER_MINUTE = 60;       // 설치(또는 등록 IP)당 분당 요청 수

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
// 시간이 일정한 문자열 비교(비교 시간으로 키를 짐작하지 못하게).
const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  response.end(JSON.stringify(body));
}

async function body(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new Invalid("요청이 너무 큽니다.");
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Invalid("JSON이 아닙니다.");
  }
}

// 분당 요청 수 제한(고장 난 클라이언트 하나가 서버를 채우지 못하게).
const recent = new Map<string, number[]>();
function limited(key: string): boolean {
  const now = Date.now();
  const list = (recent.get(key) ?? []).filter(time => now - time < 60000);
  list.push(now);
  recent.set(key, list);
  return list.length > RATE_PER_MINUTE;
}

// Bearer 토큰 → 설치 ID. 서버는 토큰의 해시만 갖고 있다.
function installOf(request: IncomingMessage): string | undefined {
  const token = /^Bearer ([a-f\d]{64})$/.exec(request.headers.authorization ?? "")?.[1];
  if (!token) return undefined;
  const hash = sha(token);
  const row = Object.values(store.installs).find(item => same(item.tokenHash, hash));
  if (!row) return undefined;
  row.lastSeen = new Date().toISOString().slice(0, 10);
  return row.installId;
}

const isReviewer = (request: IncomingMessage) => {
  const key = request.headers["x-reviewer-key"];
  return typeof key === "string" && same(sha(key), sha(config.reviewerKey));
};

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", "http://central");
    const route = `${request.method} ${url.pathname}`;

    // ── 인증 없이
    if (route === "GET /v1/health") return json(response, 200, { ok: true, version: store.official.version });

    if (route === "POST /v1/enroll") {
      if (limited(`enroll:${request.socket.remoteAddress}`)) return json(response, 429, { error: "잠시 뒤 다시 시도해 주세요." });
      const input = (await body(request)) as { installId?: unknown; enrollKey?: unknown };
      if (typeof input.installId !== "string" || !/^[a-f\d]{16}$/.test(input.installId))
        return json(response, 400, { error: "설치 ID가 맞지 않습니다." });
      if (typeof input.enrollKey !== "string" || !same(sha(input.enrollKey), sha(config.enrollKey)))
        return json(response, 403, { error: "가입키가 맞지 않습니다." });

      // 새 토큰을 만들어 해시만 저장한다(다시 등록하면 토큰이 바뀐다).
      const token = randomBytes(32).toString("hex");
      const now = new Date().toISOString().slice(0, 10);
      store.installs[input.installId] = {
        installId: input.installId,
        tokenHash: sha(token),
        enrolledAt: store.installs[input.installId]?.enrolledAt ?? now,
        lastSeen: now
      };
      store.saveInstalls();
      return json(response, 200, { token });
    }

    // ── 배포본: 설치 프로그램은 가입키(아직 설치 토큰이 없다), 팔레트는 설치 토큰으로 묻는다
    if (route === "GET /v1/release" || route === "GET /v1/release/download") {
      const key = request.headers["x-enroll-key"];
      const allowed = (typeof key === "string" && same(sha(key), sha(config.enrollKey))) || installOf(request) !== undefined;
      if (!allowed) return json(response, 403, { error: "가입키가 맞지 않습니다." });
      if (limited(`release:${request.socket.remoteAddress}`)) return json(response, 429, { error: "잠시 뒤 다시 시도해 주세요." });
      const live = current();
      if (route === "GET /v1/release") {
        if (!live) return json(response, 200, { none: true });
        const { version, sha256, size, file } = live.release;
        return json(response, 200, { version, sha256, size, file, publishedAt: live.publishedAt, ...(live.minVersion ? { minVersion: live.minVersion } : {}) });
      }
      // 받는 도중 배포 버전이 바뀌어도 요청한 버전과 다르면 거절한다(해시가 어긋나지 않게).
      if (!live || url.searchParams.get("version") !== live.release.version)
        return json(response, 409, { error: "배포 버전이 바뀌었습니다. 다시 확인해 주세요." });
      response.writeHead(200, {
        "Content-Type": "application/zip",
        "Content-Length": String(live.release.size),
        "Content-Disposition": `attachment; filename="${live.release.file}"`,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff"
      });
      createReadStream(releaseFile(live.release)).on("error", () => response.destroy()).pipe(response);
      return;
    }

    // ── 여기부터는 설치 토큰이 필요하다
    const installId = installOf(request);
    if (!installId) return json(response, 401, { error: "등록되지 않은 설치입니다. /중앙 연결로 다시 연결해 주세요." });
    if (limited(installId)) return json(response, 429, { error: "요청이 너무 많습니다." });

    // 묶음: 같은 id는 한 번만 받는다(다시 보내도 "duplicate"로 성공).
    if (route === "POST /v1/packages") {
      const { packageId, records } = validPackage(await body(request), installId);
      if (store.packages.has(packageId)) return json(response, 200, { accepted: true, duplicate: true });
      store.addPackage(installId, packageId, records);
      return json(response, 200, { accepted: true, records: records.length });
    }

    // 후보: 같은 (설치, 후보 id)는 한 번만 받는다.
    if (route === "POST /v1/candidates") {
      const list = validCandidates(await body(request));
      let accepted = 0;
      const now = new Date().toISOString();
      for (const item of list) {
        if (store.candidates.some(row => row.installId === installId && row.localId === item.localId)) continue;
        const number = store.candidates.length + 1;
        store.candidates.push({ id: `S-${number}`, installId, ...item, groupKey: groupKey(item.content), receivedAt: now, status: "pending" });
        accepted++;
      }
      if (accepted) store.saveCandidates();
      return json(response, 200, { accepted });
    }

    // 승인 지식: 설치가 가진 버전과 같으면 본문 없이.
    if (route === "GET /v1/official") {
      const since = Number(url.searchParams.get("since") ?? "0");
      if (since === store.official.version) return json(response, 200, { unchanged: true, version: since });
      const { version, publishedAt, items, parameters } = store.official;
      return json(response, 200, {
        version,
        publishedAt,
        parameters,
        items: items.map(({ id, content, approvedAt, parameter }) => ({ id, content, approvedAt, ...(parameter ? { parameter } : {}) }))
      });
    }

    // ── 여기부터는 검토자 키도 필요하다
    if (!isReviewer(request)) return json(response, 403, { error: "검토자 키가 맞지 않습니다." });

    if (route === "GET /v1/review") {
      return json(response, 200, {
        items: reviewItems(store, config),
        official: { version: store.official.version, items: store.official.items }
      });
    }

    if (route === "POST /v1/review/decide") {
      const input = (await body(request)) as { id?: unknown; decision?: unknown; reason?: unknown; content?: unknown };
      if (typeof input.id !== "string" || typeof input.decision !== "string")
        return json(response, 400, { error: "id와 decision이 필요합니다." });
      const decided = decide(store, config, {
        id: input.id,
        decision: input.decision,
        reason: typeof input.reason === "string" ? input.reason : undefined,
        content: typeof input.content === "string" ? input.content : undefined
      });
      return json(response, 200, { decided, version: store.official.version });
    }

    if (route === "GET /v1/report") return json(response, 200, report(store, config));

    json(response, 404, { error: "Not found." });
  } catch (error) {
    if (error instanceof Invalid) return json(response, 422, { error: error.message });
    if (error instanceof ReviewError) return json(response, 409, { error: error.message });
    process.stderr.write(`central error: ${String(error)}\n`);
    json(response, 500, { error: "서버 오류" });
  }
});

// 다른 PC가 쓸 주소: 네트워크에 열었으면(0.0.0.0) 이 PC의 IPv4 주소들.
function addresses(): string[] {
  if (host !== "0.0.0.0") return [host];
  return Object.values(networkInterfaces())
    .flat()
    .filter(item => item && item.family === "IPv4" && !item.internal)
    .map(item => item!.address);
}

server.on("error", error => {
  const portInUse = (error as NodeJS.ErrnoException).code === "EADDRINUSE"
    ? `포트 ${port}를 이미 쓰고 있습니다. ${settingsFile}의 port를 바꾸세요.\n`
    : "";
  process.stderr.write(`서버를 시작하지 못했습니다: ${error.message}\n` + portInUse);
  process.exit(1);
});

// 시작하면 주소, 설정 파일 위치, 각 PC에 입력할 명령을 보여 준다.
server.listen(port, host, () => {
  const urls = addresses().map(address => `http://${address}:${port}`);
  process.stderr.write([
    `my-civil3d-mcp central server: ${urls.join(", ")}`,
    `  설정 파일: ${settingsFile}`,
    `  데이터: ${dataDir}`,
    `  각 PC의 팔레트에서: /중앙 연결 ${urls[0]} ${config.enrollKey}`,
    `  검토자 키: ${join(dataDir, "config.json")}의 reviewerKey`,
    ...(host === "127.0.0.1" ? ["  지금은 이 PC에서만 접속됩니다. 다른 PC도 쓰려면 설정 파일의 host를 0.0.0.0으로 바꾸세요."] : []),
    ""
  ].join("\n"));
});
