import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeAtomic } from "../files.js";
import { dataDir } from "../paths.js";

// Connection to the central server. The token is this install's own credential from
// enrolment (the enrol key itself is never stored); reviewerKey is set only on the
// reviewer's PC. Neither is ever written to a log or sent anywhere but the server.
export type CentralSettings = { url: string; token: string; enabled: boolean; reviewerKey?: string; enrolledAt: string };
export type Settings = { schema: 1; central?: CentralSettings };

const file = () => join(dataDir(), "settings.json");

export async function loadSettings(): Promise<Settings> {
  try {
    const parsed = JSON.parse(await readFile(file(), "utf8")) as Partial<Settings>;
    if (parsed.schema === 1) return parsed as Settings;
  } catch { /* No settings yet. */ }
  return { schema: 1 };
}

export async function saveSettings(settings: Settings): Promise<void> {
  await writeAtomic(file(), JSON.stringify(settings, null, 1));
}

// A central server address the client accepts: http(s) with a host, no credentials or query.
export function centralUrl(text: string): string | undefined {
  try {
    const url = new URL(text);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash) return undefined;
    return url.origin + url.pathname.replace(/\/+$/, "");
  } catch { return undefined; }
}

// Plain http is fine on this PC or a private network; elsewhere tokens would cross the internet unencrypted.
export function insecureUrl(text: string): boolean {
  const url = new URL(text);
  if (url.protocol === "https:") return false;
  return !/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[::1\])/.test(url.hostname);
}
