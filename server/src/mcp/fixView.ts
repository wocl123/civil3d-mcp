// AI에게 보여 줄 수정안 모습.
// AI가 수정안을 설명하고 id로 동의받는 데 필요한 것만 남긴다. 적용 방법(바꿀 객체, 선형 계획이면
// 폴리라인 꼭짓점 전체를 담은 생성 요청)은 저장본(changes/changeStore.ts)에 있다. 그것까지 보내면 문맥만 채운다.

import type { CheckItem } from "../criteria/types/CheckItem.js";
import type { FixOption } from "../criteria/types/FixOption.js";

export function fixView(fix: FixOption) {
  return {
    id: fix.id,
    title: fix.title,
    applicable: fix.applicable,
    status: fix.status,
    ...(fix.reason ? { reason: fix.reason } : {}),
    ...(fix.changes.length
      ? { changes: fix.changes.map(({ property, from, to, unit }) => ({ property, ...(from !== undefined ? { from } : {}), to, unit })) }
      : {}),
    effects: fix.effects
  };
}

// 검토 항목들의 수정안을 위 모습으로 바꾼다.
export const itemsView = (items: CheckItem[]) =>
  items.map(item => item.fixes ? { ...item, fixes: item.fixes.map(fixView) } : item);
