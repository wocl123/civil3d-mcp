import { callPlugin } from "../../bridge/pluginClient.js";
import { currentDrawingScope, scopeFromStatus } from "../../memory/drawingScope.js";
import { drawingOutline, formatDrawingOutline, type AlignmentListItem } from "./drawingOutline.js";
import { readSelection, selectionOutline, type Selection } from "./drawingSelection.js";

type Context = {
  status: Record<string, unknown>;
  selection: Selection;
  selectionError?: string;
  alignments: { totalCount: number; items: AlignmentListItem[] };
};

export async function readChatContext() {
  try {
    const data = await callPlugin("drawing.chat_context") as Context;
    if (data.status && data.selection && data.alignments) {
      return {
        scope: scopeFromStatus(data.status),
        selection: { outline: selectionOutline(data.selection), count: data.selection.totalCount,
          error: data.selectionError?.slice(0, 300) },
        outline: formatDrawingOutline(data.alignments)
      };
    }
  } catch (error) {
    // 플러그인만 이전 버전일 때에 한해 기존 조회로 돌아간다. 도면/통신 오류는 숨기지 않는다.
    if (!(error instanceof Error) || !/Method not found|Unknown bridge method/.test(error.message)) {
      throw error;
    }
  }

  const [scope, selection, outline] = await Promise.all([
    currentDrawingScope(), readSelection(), drawingOutline()
  ]);
  return { scope, selection, outline };
}
