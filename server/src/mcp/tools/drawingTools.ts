import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { callPlugin } from "../../bridge/pluginClient.js";
import { toolResult } from "../toolResult.js";

export function registerDrawingTools(server: McpServer): void {
  server.registerTool("get_active_drawing", {
    title: "Active Civil 3D drawing",
    description: "Read the active drawing name, file path, units, coordinate system, and Model Space object count.",
    annotations: { readOnlyHint: true, openWorldHint: false }
  }, async () => toolResult(await callPlugin("drawing.status")));

  server.registerTool("list_drawing_layers", {
    title: "List drawing layers",
    description: "Read layer names, visibility and lock state, object counts, and object types, including COGO points. Results are paged.",
    inputSchema: { offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(200).default(50) },
    annotations: { readOnlyHint: true, openWorldHint: false }
  }, async args => toolResult(await callPlugin("drawing.layers", args)));

  server.registerTool("list_drawing_objects", {
    title: "List Model Space objects",
    description: "Read handles, types, and layers of Model Space objects, optionally filtered by exact layer name. Use a handle with get_drawing_object for details. Results are paged.",
    inputSchema: { offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(200).default(20), layer: z.string().min(1).max(255).optional() },
    annotations: { readOnlyHint: true, openWorldHint: false }
  }, async args => toolResult(await callPlugin("drawing.objects", args)));

  server.registerTool("get_drawing_object", {
    title: "Inspect drawing object",
    description: "Read one Model Space or COGO point object by handle, including available geometry and bounds.",
    inputSchema: { handle: z.string().regex(/^[0-9a-fA-F]{1,16}$/) },
    annotations: { readOnlyHint: true, openWorldHint: false }
  }, async args => toolResult(await callPlugin("drawing.object", args)));
}
