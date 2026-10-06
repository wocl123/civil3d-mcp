import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

let resolved: string | undefined;

// The folder this user's MyCivil3DMcp files live in, next to the plug-in's connection file.
export function appDataDir(): string {
  return join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "MyCivil3DMcp");
}

// Every piece of user data (memory, knowledge, logs, tracking, the outbox) lives in one
// folder per Windows user, never in the install folder, so data is never split between
// two places and an install under Program Files works the same way.
// MY_CIVIL3D_DATA_DIR moves it (tests use a temporary folder). See docs/데이터관리_설계.md.
export function dataDir(): string {
  if (resolved) return resolved;
  resolved = process.env.MY_CIVIL3D_DATA_DIR ?? join(appDataDir(), "data");
  mkdirSync(resolved, { recursive: true });
  return resolved;
}
