import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The install folder holds server/ and plugin/ side by side; build/paths.js sits two levels below it.
const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
let resolved: string | undefined;

function writable(dir: string): boolean {
  try {
    mkdirSync(dir, { recursive: true });
    const probe = join(dir, `.write-test-${process.pid}`);
    writeFileSync(probe, "");
    unlinkSync(probe);
    return true;
  } catch { return false; }
}

// Palette memory, drawing knowledge, and the AI workspace live in <install>\data,
// so they move and back up with the installation. If that folder cannot be
// written, as under Program Files, the user's local app data is used instead.
export function dataDir(): string {
  if (resolved) return resolved;
  const preferred = process.env.MY_CIVIL3D_DATA_DIR ?? join(appRoot, "data");
  if (writable(preferred)) return resolved = preferred;
  const fallback = join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "MyCivil3DMcp", "data");
  process.stderr.write(`MyCivil3DMcp data folder ${preferred} is not writable; using ${fallback}.\n`);
  mkdirSync(fallback, { recursive: true });
  return resolved = fallback;
}
