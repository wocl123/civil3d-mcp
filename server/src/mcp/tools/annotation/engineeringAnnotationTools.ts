import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { toolResult } from "../../toolResult.js";
import { planCivil } from "../shared/planCivil.js";
import { text, n, point, handle, handles, annotations, civilPlanConsent as consent } from "../shared/civilToolSchemas.js";

export function registerEngineeringAnnotationTools(server: McpServer): void {
  server.registerTool("plan_engineering_label", {
    title: "Plan native alignment, profile-view, section-view or gravity-network labels",
    description: "Actual style from list_civil_styles is required. stationOffset: source alignment/position WCS. " +
      "stationElevation: source profileView/station/elevation. offsetElevation: source sectionView handle/offset/" +
      "elevation. pipe: source gravity pipe handle/ratio 0..1. structure: source structure handle/position WCS. " +
      "Optional markerStyle/layer. Produces actual Civil labels tied to source geometry." + consent,
    inputSchema: { kind: z.enum(["stationOffset", "stationElevation", "offsetElevation", "pipe", "structure"]),
      source: text, style: text, markerStyle: text.optional(), layer: text.optional(), position: point.optional(),
      station: n.optional(), elevation: n.optional(), offset: n.optional(),
      ratio: n.min(0).max(1).optional() }, annotations
  }, async args => toolResult(await planCivil("label.engineering", args)));
  server.registerTool("plan_quantity_table", {
    title: "Plan an actual-object quantity table or explicit refresh",
    description: "quantityTable.create: exact handles, metric length/count/area, position/rowHeight/columnWidth/height " +
      "and optional layer. Length supports gravity/pressure pipe, feature line, alignment, ordinary line/arc/polyline; " +
      "area supports closed polyline or catchment XY projection. Count supports drawing entities. Stores source " +
      "handles in table. quantityTable.refresh: table handle rereads saved sources and replaces table contents. " +
      "Explicit refresh only; no real-time auto update or invented material quantities. Drawing units unchanged." + consent,
    inputSchema: { operation: z.enum(["quantityTable.create", "quantityTable.refresh"]), handles: handles.optional(),
      metric: z.enum(["length", "count", "area"]).optional(), position: point.optional(),
      rowHeight: n.positive().optional(), columnWidth: n.positive().optional(), height: n.positive().optional(),
      layer: text.optional(), table: handle.optional() }, annotations
  }, async ({ operation, ...args }) => toolResult(await planCivil(operation, args)));
}
