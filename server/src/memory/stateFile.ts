// 서비스가 다시 떠도 이어져야 하는 메모리 상태(대화 기억, AI 로그인 세션)를 data/state/<이름>.json 에 둔다.
// 서비스가 꺼졌다 켜지면(자동 재시작 포함) 파일에서 다시 읽는다.
// Civil 3D 두 개가 각자 서비스를 띄우면 같은 파일을 쓰므로, 저장할 때 파일에 있는 남의 항목을 지우지 않고
// 같은 키는 시각(stamp)이 더 새로운 쪽을 남긴다.

import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { dataDir } from "../paths.js";
import { withFileLock, writeAtomic } from "../files.js";

export type StateFile<V> = {
  map: Map<string, V>;
  save(): void;               // 지금 상태를 파일에 합쳐 쓴다(실패는 기록만)
  remove(key: string): void;  // 지우고, 파일에서도 지운다
};

export function stateFile<V>(name: string, stamp: (value: V) => number): StateFile<V> {
  const file = join(dataDir(), "state", `${name}.json`);
  const read = (text: string): [string, V][] => {
    try { return Object.entries(JSON.parse(text) as Record<string, V>); } catch { return []; }
  };

  // 시작할 때 한 번 읽는다. 오래된 것부터 넣어 Map 순서가 "최근 사용" 순서가 되게 한다.
  let initial: [string, V][] = [];
  try { initial = read(readFileSync(file, "utf8")); } catch { /* 처음이거나 못 읽음: 빈 상태 */ }
  const map = new Map(initial.sort((a, b) => stamp(a[1]) - stamp(b[1])));
  const removed = new Set<string>();

  // 저장은 한 줄로 세운다(앞 저장이 끝난 뒤 다음 저장).
  let queue = Promise.resolve();
  const save = () => {
    queue = queue.then(() => withFileLock(file, async () => {
      const merged = new Map(read(await readFile(file, "utf8").catch(() => "{}")));
      for (const key of removed) merged.delete(key);
      for (const [key, value] of map) {
        const other = merged.get(key);
        if (!other || stamp(value) >= stamp(other)) merged.set(key, value);
      }
      removed.clear();
      await writeAtomic(file, JSON.stringify(Object.fromEntries(merged)));
    })).catch(error => { process.stderr.write(`MyCivil3DMcp state save failed (${name}): ${String(error)}\n`); });
  };

  return {
    map,
    save,
    remove(key) { map.delete(key); removed.add(key); save(); }
  };
}
