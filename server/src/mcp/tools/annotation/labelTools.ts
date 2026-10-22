import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { n, annotations, text, point, handle } from "../shared/civilToolSchemas.js";
import { toolResult } from "../../toolResult.js";
import { callPlugin } from "../../../bridge/pluginClient.js";
import { consent } from "../shared/extensionToolsSchemas.js";
import { z } from "zod";
import { planCivil } from "../shared/planCivil.js";

export function registerLabelExtensions(server: McpServer): void {
  server.registerTool("list_civil_labels", {
    title: "Read individual Civil labels and text component handles",
    description: "Read individual Civil labels, positions, pins, styles and text override component handles. Follow hasMore.",
    inputSchema: { offset: n.int().nonnegative().default(0), limit: n.int().min(1).max(50).default(20) }, annotations
  }, async args => toolResult(await callPlugin("civil.labels", args)));
  server.registerTool("plan_civil_label", {
    title: "Plan Civil labels and label-style text components",
    description: "label.create: kind surfaceElevation or surfaceSlope needs surface/position (XYZ; XY sampled), " +
      "optional secondPoint for two-point slope, style/markerStyle; segment needs source/ratio (0-1 or polyline " +
      "segment index+fraction), optional paired lineStyle/curveStyle; note needs position and optional style. " +
      "label.edit: exact handle, position/pinned/flipped/rotationDegrees or overrides [{component,text}], clearOverrides. " +
      "label.delete: exact handle. style.text: styleKind/style/component from list_civil_styles and contents/height " +
      "changes ALL labels using that style. Preserve Civil field expressions deliberately. Never invent computed labels." + consent,
    inputSchema: { operation: z.enum(["label.create", "label.edit", "label.delete", "style.text"]),
      kind: z.enum(["surfaceElevation", "surfaceSlope", "segment", "note"]).optional(), surface: text.optional(),
      position: point.optional(), secondPoint: point.optional(), source: handle.optional(),
      ratio: n.nonnegative().optional(),
      style: text.optional(), markerStyle: text.optional(), lineStyle: text.optional(), curveStyle: text.optional(),
      layer: text.optional(), handle: handle.optional(), pinned: z.boolean().optional(),
      flipped: z.boolean().optional(),
      rotationDegrees: n.optional(), clearOverrides: z.boolean().optional(),
      overrides: z.array(z.object({ component: handle, text: z.string().max(4000) })).min(1).max(100).optional(),
      styleKind: z.enum(["pointLabel", "surfaceElevationLabel", "surfaceSlopeLabel", "generalLineLabel",
        "generalCurveLabel", "noteLabel"]).optional(),
      component: handle.optional(), contents: z.string().max(4000).optional(),
      height: n.positive().optional() }, annotations
  }, async ({ operation, ...args }) => toolResult(await planCivil(operation, args)));
}
