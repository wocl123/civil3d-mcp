import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { applyFix } from "../../changes/applyChange.js";
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
    return toolResult(await applyFix(fixId, offered));
  });
}
