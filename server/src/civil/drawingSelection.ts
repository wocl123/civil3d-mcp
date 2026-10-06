import { callPlugin } from "../bridge/pluginClient.js";

type Group = { name: string; count: number };
type Selection = {
  totalCount: number; byType?: Group[]; byLayer?: Group[];
  items: { handle: string; type: string; layer: string; name?: string | null;
    polyline?: { vertexCount: number; arcSegmentCount: number; closed: boolean; length: number } | null }[];
};

// What the user has selected in the drawing right now, for the prompt, so "이 폴리라인으로"
// needs no pick prompt. The outline is empty when nothing is selected or the plug-in could
// not be asked; count and error go to the work log, so a selection that was not seen can
// be traced.
export async function readSelection(): Promise<{ outline: string; count: number; error?: string }> {
  try {
    const selection = await callPlugin("drawing.selection") as Selection;
    return { outline: outline(selection), count: selection.totalCount };
  } catch (error) {
    return { outline: "", count: 0, error: (error instanceof Error ? error.message : String(error)).slice(0, 300) };
  }
}

function outline(selection: Selection): string {
  if (!selection.totalCount) return "";
  // A large selection is described by its counts; a few objects show what the handles look like.
  const large = selection.totalCount > selection.items.length;
  const shown = large ? selection.items.slice(0, 5) : selection.items;
  const lines = shown.map(item => {
    const line = item.polyline;
    const detail = line ? `, 꼭짓점 ${line.vertexCount}, 호 ${line.arcSegmentCount}, 길이 ${line.length} m${line.closed ? ", 닫힘" : ""}` : "";
    return `- ${item.type}${item.name ? ` ${item.name}` : ""} [${item.handle}, 레이어 ${item.layer}${detail}]`;
  });
  const more = selection.totalCount > shown.length ? [`- 그 밖에 ${selection.totalCount - shown.length}개 (get_selection으로 20개까지 볼 수 있음)`] : [];
  // Every selected object is counted by type and layer, so a large selection can be
  // described as a whole, not only by the first objects listed.
  const groups = (title: string, list?: Group[]) => list?.length ? [`${title}: ${list.map(group => `${group.name} ${group.count}`).join(", ")}`] : [];
  const totals = large
    ? [...groups("All selected by type", selection.byType), ...groups("All selected by layer (largest 15)", selection.byLayer)] : [];
  return [`Selected in the drawing now (${selection.totalCount}):`, ...totals, ...lines, ...more].join("\n");
}
