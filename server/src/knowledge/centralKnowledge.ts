// 중앙 서버에서 받은 승인 지식을 이 PC에 둔다.
//   - 규칙 파일 하나: rules/중앙_지식.md (always, 매 요청에 들어감)
//   - 설정값: knowledge/central-parameters.json
// 둘 다 바뀔 때마다 통째로 바뀌므로 여기서 고치는 파일이 아니다.
// 이 PC에서만 다르게 하려면 /후보(승인된_지식)로 남긴다. 그쪽이 먼저 적용된다.

import { rm } from "node:fs/promises";
import { join } from "node:path";
import { writeAtomic } from "../files.js";
import type { Official } from "../sync/centralClient.js";
import { writeCentralParameters } from "./parameters.js";
import { rulesDir } from "./rulesStore.js";

export const CENTRAL_RULE = "중앙_지식";

export async function applyOfficial(official: Official): Promise<void> {
  const rule = join(rulesDir(), `${CENTRAL_RULE}.md`);
  const items = official.items.filter(item => item.content.trim());

  // 승인 지식이 없으면 파일을 지운다.
  if (!items.length) {
    await rm(rule, { force: true });
  } else {
    await writeAtomic(rule, `---
description: 중앙 서버에서 검토자가 승인한 공통 작업 관행. 매 요청에 함께 들어간다.
always: true
---
# 중앙 지식 (v${official.version})

여러 사용자의 기록에서 모으고 검토자가 승인한 관행이다. 도면별 지식, 이 PC의 승인된 지식, 이번 질문의 사용자 말이 우선한다.
이 파일은 동기화 때 통째로 바뀐다. 이 PC에서만 다르게 하려면 /후보로 남긴다.

${items.map(item => `- ${item.content} (${item.id})`).join("\n")}
`);
  }

  await writeCentralParameters(official.parameters ?? {}, official.version);
}
