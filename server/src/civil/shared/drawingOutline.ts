// 질문 프롬프트 앞에 붙이는 "도면의 선형·종단 목록".
// AI가 목록 도구를 먼저 부르지 않고 이름으로 바로 도구를 부를 수 있게 한다.
// 플러그인이 도면 리비전별로 선형 정보를 캐시하므로 비용이 작다. 오류가 나면 그냥 뺀다.

import { callPlugin } from "../../bridge/pluginClient.js";
import { alignmentProfiles } from "./civilData.js";
import { readUses } from "../alignment/alignmentRecord.js";

const MAX_ALIGNMENTS = 15;

export type AlignmentListItem = {
  name: string;
  handle: string;
  type: string;
  startStationText: string;
  endStationText: string;
  profileCount: number;
  description?: string | null;
  profiles?: { name: string; type: string }[];
};

export function formatDrawingOutline(page: { totalCount: number; items: AlignmentListItem[] }): string {
  if (!page.items.length) {
    return "";
  }

  const lines = page.items.map(alignment => {
    const list = (alignment.profiles ?? []).map(profile => `${profile.name}(${profile.type})`).join(", ");
    const uses = readUses(alignment.description);
    const facts = [alignment.handle, alignment.type, `${alignment.startStationText}~${alignment.endStationText}`,
      ...(uses ? [`용도 ${uses.join("·")}`] : [])].join(", ");
    return `- 선형 ${alignment.name} [${facts}]` + (list ? `: 종단 ${list}` : "");
  });
  const more = page.totalCount > page.items.length ? [`- 그 밖에 선형 ${page.totalCount - page.items.length}개`] : [];
  return ["Civil objects in the drawing (use these names in tools directly):", ...lines, ...more].join("\n");
}

export async function drawingOutline(): Promise<string> {
  try {
    const page = await callPlugin("alignment.list", { offset: 0, limit: MAX_ALIGNMENTS }) as
      { totalCount: number; items: AlignmentListItem[] };
    if (!page.items.length) {
      return "";
    }

    // 선형 한 줄: "- 선형 본선 [B1, Centerline, 0+000.00~1+500.00, 용도 도로]: 종단 본선 계획선(FG)"
    const items = await Promise.all(page.items.map(async alignment => {
      const profiles = alignment.profileCount ? await alignmentProfiles(alignment.handle) : [];
      return { ...alignment, profiles };
    }));

    return formatDrawingOutline({ totalCount: page.totalCount, items });
  } catch {
    return "";
  }
}
