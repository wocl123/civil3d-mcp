import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpServer } from "./server.js";
import { inPaletteContext, type PaletteContext } from "./paletteContext.js";

// 서비스 안의 도구 코드는 한 번만 로드한다. HTTP 세션과 권한은 질문마다 따로 만든다.
type Lease = {
  handle: (request: IncomingMessage, response: ServerResponse) => Promise<void>;
};
const leases = new Map<string, Lease>();
let listening: Promise<string> | undefined;
let base = "";

function reject(response: ServerResponse, status: number): void {
  response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  response.end(JSON.stringify({ error: "MCP request is not authorized." }));
}

const host = createServer(async (request, response) => {
  const sameHost = request.headers.host === base.slice("http://".length);
  const origin = request.headers.origin;
  if (!sameHost || (origin && origin !== base) || request.url !== "/mcp") {
    return reject(response, 403);
  }

  const token = /^Bearer ([a-f\d]{64})$/.exec(request.headers.authorization ?? "")?.[1];
  const lease = token ? leases.get(token) : undefined;
  if (!lease) {
    return reject(response, 403);
  }

  try {
    await lease.handle(request, response);
  } catch {
    if (!response.headersSent) {
      reject(response, 400);
    } else {
      response.end();
    }
  }
});
host.on("connection", socket => socket.unref());
host.requestTimeout = 180000;
host.headersTimeout = 10000;

function endpoint(): Promise<string> {
  listening ??= new Promise((resolve, reject) => {
    host.once("error", reject);
    host.listen(0, "127.0.0.1", () => {
      host.off("error", reject);
      const address = host.address();
      if (!address || typeof address === "string") {
        return reject(new Error("MCP host failed to start."));
      }

      base = `http://127.0.0.1:${address.port}`;
      host.unref();
      resolve(base + "/mcp");
    });
  });
  return listening;
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  if (request.method !== "POST") {
    return undefined;
  }

  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const data = Buffer.from(chunk);
    bytes += data.length;
    if (bytes > 1024 * 1024) {
      throw new Error("MCP request is too large.");
    }

    chunks.push(data);
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export async function openPaletteMcp(context: PaletteContext) {
  const url = await endpoint();
  const token = randomBytes(32).toString("hex");
  const server = createMcpServer("palette");
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID, enableJsonResponse: true });
  await server.connect(transport);

  const controller = new AbortController();
  const scope: PaletteContext = { ...context, offeredFixes: [...context.offeredFixes], signal: controller.signal };
  let closing: Promise<void> | undefined;
  const close = async () => {
    leases.delete(token);
    controller.abort();
    clearTimeout(expiry);
    closing ??= server.close().catch(() => {
      process.stderr.write("Palette MCP session cleanup failed.\n");
    });
    await closing;
  };

  const expiry = setTimeout(() => void close(), 240000);
  expiry.unref();
  leases.set(token, {
    handle: async (request, response) => {
      const body = await readBody(request);
      // 본문 수신 중 질문이 끝나거나 취소되었어도 실행하지 않는다.
      if (!leases.has(token)) {
        return reject(response, 403);
      }

      await inPaletteContext(scope, () => transport.handleRequest(request, response, body));
    }
  });
  return { url, headers: { Authorization: `Bearer ${token}` }, close };
}
