import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { knowledgeDir } from "./knowledgeStore.js";
import { listRules } from "./rulesStore.js";
import { parameterSummary } from "./parameters.js";

// 기준표와 지연 로딩 규칙 본문도 버전에 포함한다. 파일 시각만으로는 수동 편집을 놓칠 수 있다.
export async function contentVersion(): Promise<string> {
  const hash = createHash("sha256");
  for (const folder of [join(knowledgeDir(), "criteria"),
    join(dirname(fileURLToPath(import.meta.url)), "../../knowledge-defaults/criteria")]) {
    for (const name of (await readdir(folder).catch(() => [] as string[])).filter(name => name.endsWith(".json")).sort()) {
      hash.update(name).update(await readFile(join(folder, name)));
    }
  }
  hash.update(JSON.stringify(await listRules()));
  hash.update(JSON.stringify(await parameterSummary()));
  return hash.digest("hex");
}
