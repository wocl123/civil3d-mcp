// 열린 도면과 그 상태를 알아낸다.
// 플러그인이 객체가 바뀔 때마다 리비전을 세므로, 도면을 고치면 상태가 달라진다.
// 리비전이 없는 옛 플러그인이면 객체 수·단위·좌표계를 대신 비교한다.

import { callPlugin } from "../bridge/pluginClient.js";
import { hashKey } from "./memoryStore.js";
import type { DrawingScope } from "./types/DrawingScope.js";

export async function currentDrawingScope(): Promise<DrawingScope> {
  try {
    const status = await callPlugin("drawing.status") as Record<string, unknown>;
    const path = String(status.filePath || status.drawingName || "");
    const state = typeof status.revision === "string"
      ? status.revision
      : hashKey(String(status.modelSpaceObjectCount ?? ""), String(status.drawingUnits ?? ""), String(status.coordinateSystem ?? ""));
    return { key: path.toLocaleLowerCase(), label: String(status.drawingName ?? ""), state };
  } catch {
    // 플러그인과 연결되지 않았거나 도면이 없다.
    return { key: "", label: "", state: "no-drawing" };
  }
}
