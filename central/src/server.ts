import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { dataDir, host, loadConfig, port, settingsFile } from "./config.js";
import { decide, groupKey, report, ReviewError, reviewItems } from "./review.js";
import { Store } from "./store.js";
import { Invalid, validCandidates, validPackage } from "./validate.js";

// The central server for my-civil3d-mcp installs (docs/데이터관리_설계.md §6). It takes
// de-identified records and knowledge candidates, shows the reviewer what many installs
// agree on, and serves the knowledge the reviewer approved. Plain HTTP: keep it on a
// private network, or put an HTTPS proxy in front of it for the internet.
const config = loadConfig();
const store = new Store();
const MAX_BODY = 1024 * 1024;
const RATE_PER_MINUTE = 60;

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
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
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new Invalid("JSON이 아닙니다."); }
}

// Requests per install per minute, so one broken client cannot flood the server.
const recent = new Map<string, number[]>();
function limited(key: string): boolean {
  const now = Date.now();
  const list = (recent.get(key) ?? []).filter(time => now - time < 60000);
  list.push(now);
  recent.set(key, list);
  return list.length > RATE_PER_MINUTE;
}

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
    if (route === "GET /v1/health") return json(response, 200, { ok: true, version: store.official.version });

    if (route === "POST /v1/enroll") {
      if (limited(`enroll:${request.socket.remoteAddress}`)) return json(response, 429, { error: "잠시 뒤 다시 시도해 주세요." });
      const input = (await body(request)) as { installId?: unknown; enrollKey?: unknown };
      if (typeof input.installId !== "string" || !/^[a-f\d]{16}$/.test(input.installId)) return json(response, 400, { error: "설치 ID가 맞지 않습니다." });
      if (typeof input.enrollKey !== "string" || !same(sha(input.enrollKey), sha(config.enrollKey))) return json(response, 403, { error: "가입키가 맞지 않습니다." });
      const token = randomBytes(32).toString("hex");
      const now = new Date().toISOString().slice(0, 10);
      store.installs[input.installId] = { installId: input.installId, tokenHash: sha(token), enrolledAt: store.installs[input.installId]?.enrolledAt ?? now, lastSeen: now };
      store.saveInstalls();
      return json(response, 200, { token });
    }

    const installId = installOf(request);
    if (!installId) return json(response, 401, { error: "등록되지 않은 설치입니다. /중앙 연결로 다시 연결해 주세요." });
    if (limited(installId)) return json(response, 429, { error: "요청이 너무 많습니다." });

    if (route === "POST /v1/packages") {
      const { packageId, records } = validPackage(await body(request), installId);
      if (store.packages.has(packageId)) return json(response, 200, { accepted: true, duplicate: true });
      store.addPackage(installId, packageId, records);
      return json(response, 200, { accepted: true, records: records.length });
    }
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
    if (route === "GET /v1/official") {
      const since = Number(url.searchParams.get("since") ?? "0");
      if (since === store.official.version) return json(response, 200, { unchanged: true, version: since });
      const { version, publishedAt, items, parameters } = store.official;
      return json(response, 200, { version, publishedAt, parameters, items: items.map(({ id, content, approvedAt, parameter }) => ({ id, content, approvedAt, ...(parameter ? { parameter } : {}) })) });
    }

    if (!isReviewer(request)) return json(response, 403, { error: "검토자 키가 맞지 않습니다." });
    if (route === "GET /v1/review") return json(response, 200, { items: reviewItems(store, config), official: { version: store.official.version, items: store.official.items } });
    if (route === "POST /v1/review/decide") {
      const input = (await body(request)) as { id?: unknown; decision?: unknown; reason?: unknown; content?: unknown };
      if (typeof input.id !== "string" || typeof input.decision !== "string") return json(response, 400, { error: "id와 decision이 필요합니다." });
      const decided = decide(store, config, { id: input.id, decision: input.decision,
        reason: typeof input.reason === "string" ? input.reason : undefined, content: typeof input.content === "string" ? input.content : undefined });
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

// The addresses other PCs can use: this PC's IPv4 addresses when serving the network.
function addresses(): string[] {
  if (host !== "0.0.0.0") return [host];
  return Object.values(networkInterfaces()).flat()
    .filter(item => item && item.family === "IPv4" && !item.internal).map(item => item!.address);
}

server.on("error", error => {
  process.stderr.write(`서버를 시작하지 못했습니다: ${error.message}\n` +
    ((error as NodeJS.ErrnoException).code === "EADDRINUSE" ? `포트 ${port}를 이미 쓰고 있습니다. ${settingsFile}의 port를 바꾸세요.\n` : ""));
  process.exit(1);
});

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
