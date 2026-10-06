import { readFile } from "node:fs/promises";
import { hostname, userInfo } from "node:os";
import { join } from "node:path";
import { writeAtomic } from "../files.js";
import { dataDir } from "../paths.js";

// Words that identify this user's work: drawing names and names people gave objects.
// They are kept only here (data/terms.json), never sent, and used to blank such words
// in free text and to stop any outgoing package that still contains one.
const MIN_LENGTH = 3;
const MAX_TERMS = 2000;
const file = () => join(dataDir(), "terms.json");

let writing: Promise<unknown> = Promise.resolve();

async function load(): Promise<string[]> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file(), "utf8"));
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch { return []; }
}

// Names worth hiding: a drawing "부산신항_2공구_v3.dwg" adds "부산신항_2공구_v3" and its parts.
function variants(name: string): string[] {
  const base = name.replace(/\.(dwg|dxf|dwt)$/i, "").trim();
  return [base, ...base.split(/[\s_\-.()[\]]+/)].filter(part => part.length >= MIN_LENGTH && !/^\d+$/.test(part) && !/^v\d+$/i.test(part));
}

export async function addTerms(names: (string | undefined)[]): Promise<void> {
  const wanted = names.filter((name): name is string => !!name).flatMap(variants);
  if (!wanted.length) return;
  writing = writing.then(async () => {
    const list = await load();
    const fresh = wanted.filter(term => !list.includes(term));
    if (fresh.length) await writeAtomic(file(), JSON.stringify([...fresh, ...list].slice(0, MAX_TERMS)));
  }).catch(error => process.stderr.write(`MyCivil3DMcp terms were not saved: ${String(error)}\n`));
  await writing;
}

// Every word to hide, longest first so "부산신항_2공구" is replaced before "부산신항".
export async function privateTerms(): Promise<string[]> {
  const own: string[] = [];
  try { own.push(userInfo().username); } catch { /* No user name. */ }
  own.push(hostname());
  return [...new Set([...own, ...await load()])].filter(term => term.length >= MIN_LENGTH).sort((a, b) => b.length - a.length);
}
