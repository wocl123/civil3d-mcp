import { callPlugin } from "../bridge/pluginClient.js";
import { hashKey } from "./memoryStore.js";
import type { DrawingScope } from "./types/DrawingScope.js";

// Identifies the open drawing and its current state. The plug-in counts every
// object change, so any edit gives a new state. Without that counter (older
// plug-in builds), the object count, units, and coordinate system are compared instead.
export async function currentDrawingScope(): Promise<DrawingScope> {
  try {
    const status = await callPlugin("drawing.status") as Record<string, unknown>;
    const path = String(status.filePath || status.drawingName || "");
    return {
      key: path.toLocaleLowerCase(),
      label: String(status.drawingName ?? ""),
      state: typeof status.revision === "string" ? status.revision
        : hashKey(String(status.modelSpaceObjectCount ?? ""),
          String(status.drawingUnits ?? ""), String(status.coordinateSystem ?? ""))
    };
  } catch {
    return { key: "", label: "", state: "no-drawing" };
  }
}
