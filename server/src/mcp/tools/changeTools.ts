import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { callPlugin } from "../../bridge/pluginClient.js";
import { applyFix } from "../../changes/applyChange.js";
import { loadFix } from "../../changes/changeStore.js";
import { toolResult } from "../toolResult.js";

// The only tool that changes the drawing. It takes a fix id, never values: the values
// were computed by a check tool, and the fix must have been shown to the user earlier in
// this palette conversation (the service passes those ids in MY_CIVIL3D_OFFERED_FIXES).
export function registerChangeTools(server: McpServer): void {
  server.registerTool("apply_drawing_change", {
    title: "Apply a computed fix or plan to the drawing",
    description: "Apply one computed fix or creation plan (its id from an earlier criteria check or alignment plan, such as fx-1a2b3c4d5e) to the drawing, only when the user's current message clearly agrees to it. All its changes are one undo step. Then the same check runs again and the result says whether the target (for a created road alignment, the whole alignment) now passes (recheck.targetPassed), its items, and other failures.",
    inputSchema: { fixId: z.string().regex(/^fx-[a-f\d]{10}$/) },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  }, async ({ fixId }) => {
    const offered = (process.env.MY_CIVIL3D_OFFERED_FIXES ?? "").split(",").filter(Boolean);
    const result = await applyFix(fixId, offered);
    const created = "created" in result ? result.created as { handle?: string } | undefined : undefined;
    const image = created?.handle ? await captureCreated(fixId, created.handle) : undefined;
    return image
      ? { content: [...toolResult(result).content, { type: "image" as const, data: image, mimeType: "image/png" },
          { type: "text" as const, text: "The image shows the created alignment (yellow by default) and its polyline, rendered from the drawing. Look at it and add one line to the answer starting with \"캡처로 확인:\": whether the alignment follows the polyline with the planned curves, or what looks wrong." }] }
      : toolResult(result);
  });
}

// A picture of a created alignment with the polyline it follows, so the AI looks at what
// it made. Without it (an old plug-in, a render failure) the result stands alone.
async function captureCreated(fixId: string, alignment: string): Promise<string | undefined> {
  try {
    const fix = await loadFix(fixId);
    const handles = [alignment, ...(fix.create ? [fix.create.polyline.handle] : [])];
    return (await callPlugin("drawing.capture", { handles, width: 800, height: 600 }, 60000) as { png: string }).png;
  } catch { return undefined; }
}
