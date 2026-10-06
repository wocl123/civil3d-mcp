import { callPlugin, type BridgeMethod } from "../bridge/pluginClient.js";
import type { ProfileSummary } from "./types/ProfileSummary.js";

type SectionPage = { totalCount: number; items: unknown[] };
const PAGE = 200;

// Reads every item of one alignment or profile section, page by page. Server-side
// tools use this so the AI does not have to page through sections itself.
export async function readSection<T>(method: Extract<BridgeMethod, "alignment.section" | "profile.section">,
  params: Record<string, unknown>, section: string): Promise<T[]> {
  const items: T[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const page = await callPlugin(method, { ...params, section, offset, limit: PAGE }) as SectionPage;
    items.push(...page.items as T[]);
    if (items.length >= page.totalCount || page.items.length === 0) return items;
  }
}

// Profiles attached to an alignment, from its "related" section.
export async function alignmentProfiles(alignment: string): Promise<ProfileSummary[]> {
  const [related] = await readSection<{ profiles: ProfileSummary[] }>("alignment.section", { alignment }, "related");
  return related?.profiles ?? [];
}
