import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

// 파일을 통째로 안전하게 쓴다.
// 임시 파일에 먼저 쓰고 기존 파일과 바꾸므로, 읽는 쪽이 반쯤 쓰인 파일을 보는 일이 없다.
export async function writeAtomic(file: string, text: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file + ".tmp", text, "utf8");
  await rename(file + ".tmp", file);
}
