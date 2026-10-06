import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { callPlugin } from "../../bridge/pluginClient.js";
import { toolResult } from "../toolResult.js";

const handle = z.string().regex(/^[0-9a-fA-F]{1,16}$/);
type DrawingImage = { width: number; height: number; png: string; area: number[]; framed: string[] };

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

  server.registerTool("get_selection", {
    title: "Current selection",
    description: "Read the objects the user has selected in the drawing (with grips) right now: handle, type, layer, Civil object name, and for 2D polylines vertex and arc counts, length, and whether closed. Up to 20 are listed with the total count.",
    annotations: { readOnlyHint: true, openWorldHint: false }
  }, async () => toolResult(await callPlugin("drawing.selection")));

  server.registerTool("capture_drawing", {
    title: "Capture the drawing",
    description: "Render Model Space to a PNG framed on the given objects (handles), or on the whole drawing without handles, and return the image. The user's view does not change. Use it to look at what was just created or changed, such as a new alignment with the polyline it follows, and confirm it matches the plan. The drawing's own colours on a black background; area is the shown region [minX, minY, maxX, maxY] in drawing units.",
    inputSchema: {
      handles: z.array(handle).max(50).optional(),
      width: z.number().int().min(200).max(1600).default(800),
      height: z.number().int().min(200).max(1200).default(600)
    },
    annotations: { readOnlyHint: true, openWorldHint: false }
  }, async args => {
    const image = await callPlugin("drawing.capture", args, 60000) as DrawingImage;
    return { content: [
      { type: "image" as const, data: image.png, mimeType: "image/png" },
      { type: "text" as const, text: JSON.stringify({ width: image.width, height: image.height, area: image.area, framed: image.framed }) }
    ] };
  });

  server.registerTool("get_drawing_object", {
    title: "Inspect drawing object",
    description: "Read one Model Space or COGO point object by handle, including available geometry and bounds.",
    inputSchema: { handle },
    annotations: { readOnlyHint: true, openWorldHint: false }
  }, async args => toolResult(await callPlugin("drawing.object", args)));
}
