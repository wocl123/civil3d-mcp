import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

// Writes a whole file so a reader never sees it half written: the text goes to a
// temporary file first, which then replaces the old one.
export async function writeAtomic(file: string, text: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file + ".tmp", text, "utf8");
  await rename(file + ".tmp", file);
}
