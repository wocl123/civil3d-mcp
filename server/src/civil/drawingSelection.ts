// 사용자가 지금 도면에서 선택한 객체(그립). 질문 프롬프트에 넣는다.
// 그래서 "이 폴리라인으로"라고 하면 다시 고르게 하지 않아도 된다.
// 선택이 없거나 플러그인에 묻지 못하면 빈 글. 개수와 오류는 작업 기록에 남겨,
// 선택을 못 알아본 경우 원인을 찾을 수 있게 한다.

import { callPlugin } from "../bridge/pluginClient.js";

type Group = { name: string; count: number };
type Selection = {
  totalCount: number;
  byType?: Group[];    // 선택한 모든 객체를 종류별로 센 것(큰 것부터 15개)
  byLayer?: Group[];   // 레이어별로 센 것
  items: {             // 앞의 20개
    handle: string;
    type: string;
    layer: string;
    name?: string | null;
    polyline?: { vertexCount: number; arcSegmentCount: number; closed: boolean; length: number } | null;
  }[];
};

export async function readSelection(): Promise<{ outline: string; count: number; error?: string }> {
  try {
    const selection = await callPlugin("drawing.selection") as Selection;
    return { outline: outline(selection), count: selection.totalCount };
  } catch (error) {
    return { outline: "", count: 0, error: (error instanceof Error ? error.message : String(error)).slice(0, 300) };
  }
}

// 프롬프트용 글 (AI가 읽으므로 머리말은 영어).
function outline(selection: Selection): string {
  if (!selection.totalCount) return "";

  // 많이 선택했으면 개수 요약 + 예시 5개, 적으면 전부.
  const large = selection.totalCount > selection.items.length;
  const shown = large ? selection.items.slice(0, 5) : selection.items;

  // 객체 한 줄: "- Polyline [2A1, 레이어 C-ROAD, 꼭짓점 4, 호 0, 길이 1203.5 m]"
  const lines = shown.map(item => {
    const line = item.polyline;
    const detail = line
      ? `, 꼭짓점 ${line.vertexCount}, 호 ${line.arcSegmentCount}, 길이 ${line.length} m${line.closed ? ", 닫힘" : ""}`
      : "";
    return `- ${item.type}${item.name ? ` ${item.name}` : ""} [${item.handle}, 레이어 ${item.layer}${detail}]`;
  });
  const more = selection.totalCount > shown.length
    ? [`- 그 밖에 ${selection.totalCount - shown.length}개 (get_selection으로 20개까지 볼 수 있음)`]
    : [];

  // 선택한 모든 객체의 종류별·레이어별 개수. 앞의 몇 개만이 아니라 전체를 설명할 수 있게.
  const groups = (title: string, list?: Group[]) =>
    list?.length ? [`${title}: ${list.map(group => `${group.name} ${group.count}`).join(", ")}`] : [];
  const totals = large
    ? [...groups("All selected by type", selection.byType), ...groups("All selected by layer (largest 15)", selection.byLayer)]
    : [];

  return [`Selected in the drawing now (${selection.totalCount}):`, ...totals, ...lines, ...more].join("\n");
}
