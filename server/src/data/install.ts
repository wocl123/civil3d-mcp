// 익명 설치 ID (data/install.json).
// 관리자에게 보내는 기록과 드라이브 보내기 폴더 이름에 붙는다. 무작위로 한 번 만들고, 사용자·PC·도면과 아무 관계가 없다.
// 그래서 관리자는 "몇 곳의 설치에서 이런 일이 있었나"를 셀 수 있지만, 기록만으로는 누구인지 모른다.

import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeAtomic } from "../files.js";
import { dataDir } from "../paths.js";

export type Install = { schema: 1; installId: string; createdAt: string };

let cached: Install | undefined;

export async function install(): Promise<Install> {
  if (cached) return cached;
  const file = join(dataDir(), "install.json");

  // 이미 있으면 그것을 쓴다.
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as Partial<Install>;
    if (parsed.schema === 1 && typeof parsed.installId === "string" && /^[a-f\d]{16}$/.test(parsed.installId))
      return cached = parsed as Install;
  } catch {
    // 아래에서 만든다.
  }

  cached = { schema: 1, installId: randomBytes(8).toString("hex"), createdAt: new Date().toISOString() };
  await writeAtomic(file, JSON.stringify(cached, null, 1));
  return cached;
}
