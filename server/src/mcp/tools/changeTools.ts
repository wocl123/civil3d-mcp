// 도면을 바꾸는 유일한 도구 (apply_drawing_change).
// 값이 아니라 수정안 id만 받는다. 값은 검토 도구가 계산했고, 그 수정안은 이 팔레트 대화에서
// 앞서 사용자에게 보여 준 것이어야 한다(서비스가 그 id들을 MY_CIVIL3D_OFFERED_FIXES 로 넘긴다).
// 도구 설명은 AI가 읽으므로 영어로 둔다.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { callPlugin } from "../../bridge/pluginClient.js";
import { applyFix } from "../../changes/applyChange.js";
import { loadFix } from "../../changes/changeStore.js";
import { itemsView } from "../fixView.js";
import { toolResult } from "../toolResult.js";

// 새로 만든 선형의 캡처를 붙일 때 AI에게 주는 안내.
const CAPTURE_NOTE = "The image shows the created alignment (yellow by default) and its polyline, rendered from the drawing. " +
  "Look at it and add one line to the answer starting with \"캡처로 확인:\": whether the alignment follows the polyline " +
  "with the planned curves, or what looks wrong.";

export function registerChangeTools(server: McpServer): void {
  server.registerTool("apply_drawing_change", {
    title: "Apply a computed fix or plan to the drawing",
    description: "Apply one computed fix or creation plan (its id from an earlier criteria check or alignment plan, such as " +
      "fx-1a2b3c4d5e) to the drawing, only when the user's current message clearly agrees to it. All its changes are one " +
      "undo step. Then the same check runs again and the result says whether the target (for a created road alignment, " +
      "the whole alignment) now passes (recheck.targetPassed), its items, and other failures.",
    inputSchema: { fixId: z.string().regex(/^fx-[a-f\d]{10}$/) },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  }, async ({ fixId }) => {
    // 1) 적용 (앞서 보여 준 id만 허용)
    const offered = (process.env.MY_CIVIL3D_OFFERED_FIXES ?? "").split(",").filter(Boolean);
    const applied = await applyFix(fixId, offered);

    // 2) 다시 검토 결과의 수정안도 AI용 모습으로
    const result = "recheck" in applied && typeof applied.recheck === "object" && applied.recheck
      ? { ...applied, recheck: { ...applied.recheck, targetItems: itemsView(applied.recheck.targetItems) } }
      : applied;

    // 3) 새 선형을 만들었으면 캡처를 붙인다(AI가 직접 보고 확인하도록).
    const created = "created" in result ? result.created as { handle?: string } | undefined : undefined;
    const image = created?.handle ? await captureCreated(fixId, created.handle) : undefined;
    if (!image) return toolResult(result);

    return {
      content: [
        ...toolResult(result).content,
        { type: "image" as const, data: image, mimeType: "image/png" },
        { type: "text" as const, text: CAPTURE_NOTE }
      ]
    };
  });
}

// 새로 만든 선형과 그 폴리라인을 함께 캡처한다.
// 못 하면(옛 플러그인, 렌더링 실패) 캡처 없이 결과만 돌려준다.
async function captureCreated(fixId: string, alignment: string): Promise<string | undefined> {
  try {
    const fix = await loadFix(fixId);
    const handles = [alignment, ...(fix.create ? [fix.create.polyline.handle] : [])];
    const image = await callPlugin("drawing.capture", { handles, width: 800, height: 600 }, 60000) as { png: string };
    return image.png;
  } catch {
    return undefined;
  }
}
