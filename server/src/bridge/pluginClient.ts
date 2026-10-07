// Civil 3D 플러그인과 통신하는 TCP 클라이언트.
// 요청 하나 = 연결 하나: JSON-RPC 한 줄을 보내고 한 줄을 받는다.
// 플러그인이 connection.json 에 적어 둔 포트와 토큰을 쓴다.

import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { createConnection } from "node:net";
import { StringDecoder } from "node:string_decoder";
import { drawingContext } from "./drawingContext.js";

// 플러그인이 아는 요청 이름(PluginBridge.cs 와 같아야 한다).
export type BridgeMethod =
  | "drawing.status" | "drawing.objects" | "drawing.layers" | "drawing.object"
  | "alignment.list" | "alignment.get" | "alignment.section"
  | "profile.get" | "profile.section"
  | "change.apply" | "alignment.create" | "change.undo" | "change.result" | "change.cancel"
  | "drawing.polylines" | "drawing.pick_polyline" | "drawing.selection" | "drawing.capture" | "drawing.summary"
  | "drawing.delete_preview" | "drawing.delete";

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

// 플러그인 연결 파일 위치: %LOCALAPPDATA%\MyCivil3DMcp\connection.json (테스트는 환경 변수로 바꾼다).
export function connectionFile(): string {
  if (process.env.MY_CIVIL3D_CONNECTION_FILE) return process.env.MY_CIVIL3D_CONNECTION_FILE;
  const localAppData = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
  return join(localAppData, "MyCivil3DMcp", "connection.json");
}

// 플러그인에 요청 하나를 보내고 결과를 받는다.
// timeoutMs는 사용자를 기다리는 요청(폴리라인 고르기 등)만 길게 준다.
export async function callPlugin(method: BridgeMethod, params: Record<string, unknown> = {}, timeoutMs = 30000): Promise<unknown> {
  // 1) 연결 정보
  let config: { port?: number; token?: string };
  try {
    config = JSON.parse(await readFile(connectionFile(), "utf8")) as typeof config;
  } catch {
    throw new Error("Civil 3D plugin connection was not found. Run NETLOAD and MYC3DCONNECTION in Civil 3D.");
  }
  const validPort = Number.isInteger(config.port) && config.port! >= 1 && config.port! <= 65535;
  const validToken = typeof config.token === "string" && /^[a-f\d]{64}$/i.test(config.token);
  if (!validPort || !validToken) throw new Error("Civil 3D plugin connection settings are invalid.");

  // 2) 요청 한 줄 보내고, 응답 한 줄 받기
  // (오류 메시지는 영어로 둔다: errors/failureGuide.ts 가 이 문구로 실패 종류를 가린다.)
  const id = randomUUID();
  const request = JSON.stringify({ jsonrpc: "2.0", id, token: config.token, method, params, ...(method === "drawing.status" ? {} : { context: drawingContext() }) }) + "\n";

  return await new Promise<unknown>((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port: config.port! });
    let response = "";
    const decoder = new StringDecoder("utf8");
    let receivedBytes = 0;
    let settled = false;
    let requestSent = false;

    // 한 번만 끝낸다(성공이든 실패든).
    const finish = (error?: Error, result?: unknown) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) {
        // 전송 뒤 응답을 못 받으면 커밋 여부를 단정하지 않는다. 명시적 플러그인 거절만 false다.
        if (!("drawingChanged" in error) || (error as { drawingChanged?: unknown }).drawingChanged === undefined)
          Object.assign(error, { drawingChanged: requestSent && ["change.apply", "alignment.create", "drawing.delete", "change.undo"].includes(method) ? "unknown" : false });
        reject(error);
      }
      else resolve(result);
    };

    socket.setTimeout(timeoutMs, () => finish(new Error("Civil 3D plugin request timed out.")));
    socket.on("connect", () => { requestSent = true; socket.write(request); });
    socket.on("error", (error) => finish(new Error(`Civil 3D plugin is unavailable: ${error.message}`)));

    socket.on("data", (chunk: Buffer) => {
      // 한글을 TCP 조각 경계에서 복원하고 수신 크기는 바이트로 제한한다.
      receivedBytes += chunk.length;
      response += decoder.write(chunk);
      if (receivedBytes > MAX_RESPONSE_BYTES) {
        finish(new Error("Civil 3D plugin response exceeded 2 MiB."));
        return;
      }

      // 줄바꿈이 올 때까지 모은다.
      const end = response.indexOf("\n");
      if (end < 0) return;

      try {
        const message = JSON.parse(response.slice(0, end)) as {
          jsonrpc?: string;
          id?: string;
          result?: unknown;
          error?: { code?: number; message?: string; kind?: string; drawingChanged?: boolean | "unknown" };
        };
        if (message.jsonrpc !== "2.0" || message.id !== id) throw new Error("Invalid plugin response.");
        if (message.error) throw Object.assign(new Error(message.error.message ?? "Civil 3D plugin error."), { kind: message.error.kind, drawingChanged: message.error.drawingChanged ?? false });
        finish(undefined, message.result);
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });

    socket.on("close", () => {
      if (!settled) finish(new Error("Civil 3D plugin closed the connection."));
    });
  });
}
