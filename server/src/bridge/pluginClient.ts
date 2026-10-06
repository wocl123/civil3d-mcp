import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { createConnection } from "node:net";

export type BridgeMethod = "drawing.status" | "drawing.objects" | "drawing.layers" | "drawing.object" |
  "alignment.list" | "alignment.get" | "alignment.section" | "profile.get" | "profile.section" |
  "change.apply" | "alignment.create" | "drawing.polylines" | "drawing.pick_polyline" | "drawing.selection";

export function connectionFile(): string {
  if (process.env.MY_CIVIL3D_CONNECTION_FILE) return process.env.MY_CIVIL3D_CONNECTION_FILE;
  const localAppData = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
  return join(localAppData, "MyCivil3DMcp", "connection.json");
}

// timeoutMs is longer only for requests that wait for the user, such as a pick prompt.
export async function callPlugin(method: BridgeMethod, params: Record<string, unknown> = {}, timeoutMs = 30000): Promise<unknown> {
  let config: { port?: number; token?: string };
  try {
    config = JSON.parse(await readFile(connectionFile(), "utf8")) as typeof config;
  } catch {
    throw new Error("Civil 3D plugin connection was not found. Run NETLOAD and MYC3DCONNECTION in Civil 3D.");
  }
  if (!Number.isInteger(config.port) || config.port! < 1 || config.port! > 65535 ||
      typeof config.token !== "string" || !/^[a-f\d]{64}$/i.test(config.token)) {
    throw new Error("Civil 3D plugin connection settings are invalid.");
  }

  const id = randomUUID();
  const request = JSON.stringify({ jsonrpc: "2.0", id, token: config.token, method, params }) + "\n";
  return await new Promise<unknown>((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port: config.port! });
    let response = "";
    let settled = false;
    const finish = (error?: Error, result?: unknown) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error); else resolve(result);
    };
    socket.setTimeout(timeoutMs, () => finish(new Error("Civil 3D plugin request timed out.")));
    socket.on("connect", () => socket.write(request));
    socket.on("error", (error) => finish(new Error(`Civil 3D plugin is unavailable: ${error.message}`)));
    socket.on("data", (chunk: Buffer) => {
      response += chunk.toString("utf8");
      if (Buffer.byteLength(response, "utf8") > 2 * 1024 * 1024) {
        finish(new Error("Civil 3D plugin response exceeded 2 MiB."));
        return;
      }
      const end = response.indexOf("\n");
      if (end < 0) return;
      try {
        const message = JSON.parse(response.slice(0, end)) as {
          jsonrpc?: string; id?: string; result?: unknown;
          error?: { code?: number; message?: string };
        };
        if (message.jsonrpc !== "2.0" || message.id !== id) throw new Error("Invalid plugin response.");
        if (message.error) throw new Error(message.error.message ?? "Civil 3D plugin error.");
        finish(undefined, message.result);
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
    socket.on("close", () => { if (!settled) finish(new Error("Civil 3D plugin closed the connection.")); });
  });
}
