import { callPlugin } from "../bridge/pluginClient.js";

type Selection = {
  totalCount: number;
  items: { handle: string; type: string; layer: string; name?: string | null;
    polyline?: { vertexCount: number; arcSegmentCount: number; closed: boolean; length: number } | null }[];
};

// What the user has selected in the drawing right now, for the prompt, so "이 폴리라인으로"
// needs no pick prompt. Empty when nothing is selected or the plug-in cannot tell.
export async function selectionOutline(): Promise<string> {
  try {
    const selection = await callPlugin("drawing.selection") as Selection;
    if (!selection.totalCount) return "";
    const lines = selection.items.map(item => {
      const line = item.polyline;
      const detail = line ? `, 꼭짓점 ${line.vertexCount}, 호 ${line.arcSegmentCount}, 길이 ${line.length} m${line.closed ? ", 닫힘" : ""}` : "";
      return `- ${item.type}${item.name ? ` ${item.name}` : ""} [${item.handle}, 레이어 ${item.layer}${detail}]`;
    });
    const more = selection.totalCount > selection.items.length ? [`- 그 밖에 ${selection.totalCount - selection.items.length}개`] : [];
    return [`Selected in the drawing now (${selection.totalCount}):`, ...lines, ...more].join("\n");
  } catch { return ""; }
}
