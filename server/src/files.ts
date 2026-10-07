import { mkdir, rename, writeFile, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

// 고유 임시 파일에 쓴 뒤 교체한다. 파일 갱신의 동시성은 withFileLock으로 별도 보호한다.
export async function writeAtomic(file: string, text: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, text, "utf8"); await rename(temporary, file); }
  finally { await rm(temporary, { force: true }); }
}

// mkdir 잠금으로 프로세스간 읽기-수정-쓰기를 직렬화한다. 오래된 잠금은 강제 탈취하지 않는다.
export async function withFileLock<T>(file: string, work: () => Promise<T>): Promise<T> {
  await mkdir(dirname(file), { recursive: true });
  const lock = file + ".lock";
  const deadline = Date.now() + 5000;
  while (true) {
    try { await mkdir(lock); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || Date.now() >= deadline) throw error;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
  try { return await work(); } finally { await rm(lock, { recursive: true, force: true }); }
}
