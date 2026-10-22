import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { consent, points } from "../shared/extensionToolsSchemas.js";
import { z } from "zod";
import { text, handle, n, annotations } from "../shared/civilToolSchemas.js";
import { toolResult } from "../../toolResult.js";
import { planCivil } from "../shared/planCivil.js";
import { callPlugin } from "../../../bridge/pluginClient.js";

export function registerSurfaceExtensions(server: McpServer): void {
  server.registerTool("plan_surface_definition", {
    title: "Plan TIN definitions, triangle edges, contour extraction and LandXML import",
    description: "paste: surface/sourceSurface (cycles refused). contours: surface/handles of existing 2D polylines, " +
      "midOrdinate/maximumDistance/weedingDistance/weedingAngle (radians). dem: surface/path. boundary: surface/points " +
      "closed ring/boundaryType/midOrdinate. removeBoundary: surface/index. swapEdge/deleteEdge: surface/x/y on edge. " +
      "simplify: surface/percentage/maximumElevationChange. extractContours: surface/elevationMin/Max/interval/layer " +
      "creates drawing polylines. landxml: absolute path/name/xmlSurface/layer imports an exact named surface; " +
      "coordinates are NOT transformed. Files are fingerprinted before applying. Design values must be explicit." + consent,
    inputSchema: { action: z.enum(["paste", "contours", "dem", "boundary", "removeBoundary", "swapEdge",
      "deleteEdge", "simplify", "extractContours", "landxml"]),
    surface: text.optional(), sourceSurface: text.optional(), handles: z.array(handle).min(1).max(1000).optional(),
    midOrdinate: n.positive().optional(), maximumDistance: n.nonnegative().optional(),
    weedingDistance: n.nonnegative().optional(),
    weedingAngle: n.nonnegative().optional(), path: z.string().min(1).max(4096).optional(), name: text.optional(),
    xmlSurface: text.optional(), layer: text.optional(), points: points.optional(),
    boundaryType: z.enum(["Outer", "Hide", "Show", "DataClip"]).optional(),
    index: n.int().nonnegative().optional(), x: n.optional(), y: n.optional(),
    percentage: n.positive().lt(100).optional(),
    maximumElevationChange: n.positive().optional(), elevationMin: n.optional(), elevationMax: n.optional(),
    interval: n.positive().optional() }, annotations
  }, async args => toolResult(await planCivil("surface.definition", args)));
}

export function registerSurfaceSamplingTool(server: McpServer): void {
  server.registerTool("sample_surface", {
    title: "Read TIN elevations and slopes at explicit XY coordinates",
    description: "Sample existing TIN terrain at WCS XY coordinates. Elevations use drawing units; slope is rise/run " +
      "(multiply by 100 for percent). Outside points return inside=false; no extrapolated elevations.",
    inputSchema: { surface: text, points: z.array(z.object({ x: n, y: n })).min(1).max(1000) }, annotations
  }, async args => toolResult(await callPlugin("surface.sample", args)));
}
