import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { consent, name, annotations } from "../shared/civilToolsSchemas.js";
import { z } from "zod";
import { toolResult } from "../../toolResult.js";
import { planCivil } from "../shared/planCivil.js";

export function registerDrawingDisplayTool(server: McpServer): void {
  server.registerTool("plan_drawing_display", {
    title: "Plan selecting or isolating drawing objects",
    description: "Select objects by handles, select all objects on a layer, set current layer, isolate/hide objects " +
      "individually (even on a shared layer), restore native object isolation, or open the Civil 3D object viewer. " +
      "For layer selection choose selectLayer (objects) or currentLayer (drawing layer); ask if ambiguous. " +
      "Frozen/off layers are not changed automatically. Object viewer requires the Civil command to be installed." + consent,
    inputSchema: { action: z.enum(["select", "selectLayer", "currentLayer", "isolate", "hide", "restore", "viewer"]),
      handles: z.array(z.string().regex(/^[0-9a-fA-F]{1,16}$/)).min(1).max(1000).optional(),
      layer: name.optional() }, annotations
  }, async args => toolResult(await planCivil("drawing.display", args)));
}
