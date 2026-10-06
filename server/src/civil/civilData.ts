// 플러그인에서 선형·종단 정보를 읽는 공용 함수.

import { callPlugin, type BridgeMethod } from "../bridge/pluginClient.js";
import type { ProfileSummary } from "./types/ProfileSummary.js";

type SectionPage = { totalCount: number; items: unknown[] };
const PAGE = 200;

// 선형이나 종단의 구간(section) 하나를 처음부터 끝까지 페이지 단위로 읽는다.
// 서버 쪽 도구가 이것을 쓰므로 AI가 직접 페이지를 넘길 필요가 없다.
export async function readSection<T>(
  method: Extract<BridgeMethod, "alignment.section" | "profile.section">,
  params: Record<string, unknown>,
  section: string
): Promise<T[]> {
  const items: T[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const page = await callPlugin(method, { ...params, section, offset, limit: PAGE }) as SectionPage;
    items.push(...page.items as T[]);
    if (items.length >= page.totalCount || page.items.length === 0) return items;
  }
}

// 선형에 붙은 종단 목록 (선형의 "related" 구간에서).
export async function alignmentProfiles(alignment: string): Promise<ProfileSummary[]> {
  const [related] = await readSection<{ profiles: ProfileSummary[] }>("alignment.section", { alignment }, "related");
  return related?.profiles ?? [];
}
