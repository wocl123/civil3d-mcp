// 가릴 낱말 (data/terms.json).
// 사용자 작업을 드러내는 낱말: 도면 이름, 사람이 객체에 붙인 이름.
// 이 파일에만 두고 절대 보내지 않는다. 이 낱말로
//   - 자유 글(지식 후보)에서 해당 부분을 <이름>으로 바꾸고,
//   - 보낼 묶음에 아직 남아 있으면 그 묶음을 막는다(sync/privacy.ts).

import { readFile } from "node:fs/promises";
import { hostname, userInfo } from "node:os";
import { join } from "node:path";
import { writeAtomic } from "../files.js";
import { dataDir } from "../paths.js";

const MIN_LENGTH = 3;     // 이보다 짧은 낱말은 흔한 말과 겹치기 쉬워 쓰지 않는다
const MAX_TERMS = 2000;
const file = () => join(dataDir(), "terms.json");

let writing: Promise<unknown> = Promise.resolve();

async function load(): Promise<string[]> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file(), "utf8"));
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

// 이름에서 가릴 낱말들: "부산신항_2공구_v3.dwg" → "부산신항_2공구_v3", "부산신항", "2공구".
// 숫자만 있거나 v3 같은 버전 표시는 뺀다.
function variants(name: string): string[] {
  const base = name.replace(/\.(dwg|dxf|dwt)$/i, "").trim();
  return [base, ...base.split(/[\s_\-.()[\]]+/)]
    .filter(part => part.length >= MIN_LENGTH && !/^\d+$/.test(part) && !/^v\d+$/i.test(part));
}

// 이름들을 가릴 낱말에 더한다(새 것만, 최근 것이 앞).
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

// 가릴 낱말 전부(Windows 사용자 이름과 PC 이름 포함).
// 긴 것부터 둔다: "부산신항_2공구"를 "부산신항"보다 먼저 바꾸도록.
export async function privateTerms(): Promise<string[]> {
  const own: string[] = [];
  try {
    own.push(userInfo().username);
  } catch {
    // 사용자 이름을 알 수 없다.
  }
  own.push(hostname());
  return [...new Set([...own, ...await load()])]
    .filter(term => term.length >= MIN_LENGTH)
    .sort((a, b) => b.length - a.length);
}
