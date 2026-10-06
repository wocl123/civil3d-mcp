import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeAtomic } from "../files.js";
import { dataDir } from "../paths.js";

// The anonymous id this install sends with its records: random, made once, and unrelated
// to the user, the PC, or the drawings, so the central server can count "how many
// installs saw this" without knowing who they are.
export type Install = { schema: 1; installId: string; createdAt: string };

let cached: Install | undefined;

export async function install(): Promise<Install> {
  if (cached) return cached;
  const file = join(dataDir(), "install.json");
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as Partial<Install>;
    if (parsed.schema === 1 && typeof parsed.installId === "string" && /^[a-f\d]{16}$/.test(parsed.installId))
      return cached = parsed as Install;
  } catch { /* Made below. */ }
  cached = { schema: 1, installId: randomBytes(8).toString("hex"), createdAt: new Date().toISOString() };
  await writeAtomic(file, JSON.stringify(cached, null, 1));
  return cached;
}
