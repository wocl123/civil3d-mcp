import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import type { Provider } from "./types/Provider.js";

// Finds each AI CLI without trusting only this process's PATH. The service inherits
// Civil 3D's environment, which is as old as the moment Civil 3D (or Explorer) started:
// a CLI installed after that, or installed for the user only, is missing from it. So the
// user's and the machine's PATH are read fresh from the registry, and the places the
// official installers use are looked at directly. Found folders are put in front of
// PATH for the CLI's own process (aiCli.ts), so it also finds its own helpers.
const EXTENSIONS = process.platform === "win32" ? [".exe", ".cmd", ".bat"] : [""];
const POSITIVE_TTL_MS = 60 * 1000;

const home = homedir();
const appData = process.env.APPDATA ?? join(home, "AppData", "Roaming");
const localAppData = process.env.LOCALAPPDATA ?? join(home, "AppData", "Local");

// Where the official installers put each CLI.
const KNOWN_DIRS: Record<Provider, string[]> = {
  claude: [join(home, ".local", "bin"), join(appData, "npm"), join(localAppData, "Programs", "claude")],
  codex: [join(appData, "npm"), join(localAppData, "Programs", "codex")],
  gemini: [join(appData, "npm")]
};

export type CliLocation = { dir: string; file: string };
const found = new Map<Provider, { location: CliLocation; at: number }>();

function regPath(key: string): Promise<string[]> {
  if (process.platform !== "win32") return Promise.resolve([]);
  return new Promise(resolve => execFile("reg.exe", ["query", key, "/v", "Path"], { windowsHide: true, timeout: 5000 }, (error, stdout) => {
    if (error) return resolve([]);
    const value = /Path\s+REG_(?:EXPAND_)?SZ\s+(.*)/i.exec(stdout)?.[1] ?? "";
    // %USERPROFILE% and the like are expanded the way Windows does for a new process.
    resolve(value.split(";").map(part => part.trim().replace(/%([^%]+)%/g, (_, name: string) => process.env[name] ?? `%${name}%`)).filter(Boolean));
  }));
}

// MY_CIVIL3D_CLI_DIRS (folders separated by ";") limits the search to those folders, for a
// PC that keeps the CLIs in one place and for tests that need a PC without them.
const onlyDirs = () => process.env.MY_CIVIL3D_CLI_DIRS?.split(delimiter).filter(Boolean);
const windowsDir = join(process.env.SystemRoot ?? "C:\\Windows", "System32");

async function searchDirs(provider: Provider): Promise<string[]> {
  const only = onlyDirs();
  if (only) return [...only, windowsDir];
  const [user, machine] = await Promise.all([
    regPath("HKCU\\Environment"),
    regPath("HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment")
  ]);
  const current = (process.env.PATH ?? process.env.Path ?? "").split(delimiter).filter(Boolean);
  return [...new Set([...current, ...user, ...machine, ...KNOWN_DIRS[provider]])];
}

export async function locateCli(provider: Provider): Promise<CliLocation | undefined> {
  const cached = found.get(provider);
  if (cached && Date.now() - cached.at < POSITIVE_TTL_MS && existsSync(cached.location.file)) return cached.location;
  for (const dir of await searchDirs(provider))
    for (const extension of EXTENSIONS) {
      const file = join(dir, provider + extension);
      if (existsSync(file)) {
        const location = { dir, file };
        found.set(provider, { location, at: Date.now() });
        return location;
      }
    }
  found.delete(provider);
  return undefined;
}

// After an install window was opened, the next look must not reuse an old answer.
export const forgetCli = (provider: Provider) => found.delete(provider);

// PATH for the CLI's process: its own folder first, then the fresh user and machine PATH.
export async function cliPath(provider: Provider, location: CliLocation): Promise<string> {
  return [location.dir, ...await searchDirs(provider)].join(delimiter);
}

// PATH for a setup window: the fresh user and machine PATH, so npm and new installs are found.
export async function freshPath(provider: Provider): Promise<string> {
  return (await searchDirs(provider)).join(delimiter);
}
