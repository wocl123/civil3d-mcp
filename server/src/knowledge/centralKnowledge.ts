import { rm } from "node:fs/promises";
import { join } from "node:path";
import { writeAtomic } from "../files.js";
import type { Official } from "../sync/centralClient.js";
import { writeCentralParameters } from "./parameters.js";
import { rulesDir } from "./rulesStore.js";

// The central server's approved knowledge on this PC: one always-included rule file and
// the central settings. Both are replaced as a whole on every change, so they are not for
// editing here; a practice that differs on this PC belongs in /후보 (승인된_지식), which
// comes first.
export const CENTRAL_RULE = "중앙_지식";

export async function applyOfficial(official: Official): Promise<void> {
  const rule = join(rulesDir(), `${CENTRAL_RULE}.md`);
  const items = official.items.filter(item => item.content.trim());
  if (!items.length) await rm(rule, { force: true });
  else await writeAtomic(rule, `---
description: 중앙 서버에서 검토자가 승인한 공통 작업 관행. 매 요청에 함께 들어간다.
always: true
---
# 중앙 지식 (v${official.version})

여러 사용자의 기록에서 모으고 검토자가 승인한 관행이다. 도면별 지식, 이 PC의 승인된 지식, 이번 질문의 사용자 말이 우선한다.
이 파일은 동기화 때 통째로 바뀐다. 이 PC에서만 다르게 하려면 /후보로 남긴다.

${items.map(item => `- ${item.content} (${item.id})`).join("\n")}
`);
  await writeCentralParameters(official.parameters ?? {}, official.version);
}
