import { callPlugin } from "./pluginClient.js";
import { drawingContext, inDrawingContext, type DrawingContext } from "./drawingContext.js";
import { contentVersion } from "../knowledge/contentVersion.js";

const changed = (kind: string, message: string) => Object.assign(new Error(message), { kind, drawingChanged: false });

// 페이지뿐 아니라 계산에 쓰인 기준표도 한 버전에 묶는다. 도중 수정된 기준으로 결과를 승인하지 않는다.
export async function withDrawing<T>(work: () => Promise<T>): Promise<T> {
  const existing = drawingContext();
  const status = existing ?? await callPlugin("drawing.status") as Partial<DrawingContext>;
  const expected = process.env.MY_CIVIL3D_DRAWING_ID;
  if (expected && expected !== status.drawingId) throw changed("drawing_mismatch", "Drawing changed since the palette request started.");
  if (!status.drawingId || !status.revision) return work();
  const context: DrawingContext = { drawingId: status.drawingId, revision: status.revision,
    criteriaVersion: existing?.criteriaVersion ?? await contentVersion() };
  return inDrawingContext(context, async () => {
    const result = await work();
    const after = await callPlugin("drawing.status") as DrawingContext;
    if (after.drawingId !== context.drawingId || after.revision !== context.revision)
      throw changed("revision_mismatch", "Drawing changed since the calculation started. Run the check again.");
    if (context.criteriaVersion !== await contentVersion())
      throw changed("criteria_changed", "Criteria changed during the calculation. Run the check again.");
    return result;
  });
}
