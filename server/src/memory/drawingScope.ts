import { isAbsolute, win32 } from "node:path";
import { callPlugin } from "../bridge/pluginClient.js";
import type { DrawingScope } from "./types/DrawingScope.js";

// 연결 실패를 전달한다. 가짜 no-drawing 문맥으로 답을 캐시하지 않는다.
export async function currentDrawingScope(): Promise<DrawingScope> {
  const status = await callPlugin("drawing.status") as Record<string, unknown>;
  const path = String(status.filePath || "");
  // 미저장 도면의 기본 이름은 영구 지식 파일의 키로 쓰지 않는다.
  const savedPath = isAbsolute(path) || win32.isAbsolute(path) ? path : "";
  return { key: savedPath.toLocaleLowerCase(), label: String(status.drawingName ?? ""),
    state: typeof status.revision === "string" ? status.revision : "legacy",
    drawingId: typeof status.drawingId === "string" ? status.drawingId : undefined };
}
