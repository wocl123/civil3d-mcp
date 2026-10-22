import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { consent, points } from "../shared/extensionToolsSchemas.js";
import { z } from "zod";
import { handle, n, annotations, text, point } from "../shared/civilToolSchemas.js";
import { toolResult } from "../../toolResult.js";
import { planCivil } from "../shared/planCivil.js";
import { callPlugin } from "../../../bridge/pluginClient.js";

export function registerGeometryCornerTool(server: McpServer): void {
  server.registerTool("plan_geometry_corner", {
    title: "Plan line fillets, chamfers or joins",
    description: "fillet: two ordinary XY lines meeting at an endpoint plus radius; chamfer: same plus distanceA/B; " +
      "join: 2-100 coplanar lines in chain order with matching endpoints/properties, replaced by one polyline. " +
      "Fillet/chamfer trim both original lines and add an arc/line; original line handles remain." + consent,
    inputSchema: { action: z.enum(["fillet", "chamfer", "join"]), handles: z.array(handle).min(2).max(100),
      radius: n.positive().optional(), distanceA: n.positive().optional(),
      distanceB: n.positive().optional() }, annotations
  }, async args => toolResult(await planCivil("geometry.corner", args)));

  server.registerTool("plan_layer_properties", {
    title: "Plan detailed layer properties",
    description: "Rename a layer, set an already-loaded explicit linetype, lineweight in 1/100 mm (25=0.25mm, " +
      "-3=Default), transparency percent 0-90, or plottable. Reserved layer names and xrefs cannot be renamed." + consent,
    inputSchema: { layer: text, newName: text.optional(), linetype: text.optional(), lineweight: n.int().optional(),
      transparency: n.min(0).max(90).optional(), plottable: z.boolean().optional() }, annotations
  }, async args => toolResult(await planCivil("layer.properties", args)));

  server.registerTool("plan_geometry_operation", {
    title: "Plan basic geometry operations",
    description: "copy, mirror (WCS vertical plane through axisStart/axisEnd; eraseSource transforms original), " +
      "offset (signed API distance), linear array (count includes source), trim (KEEP distance interval), " +
      "break (REMOVE distance interval), extend (line/arc to point), vertices (replace 2D polyline vertices), " +
      "polyline3d (create). Ordinary LINE/LWPOLYLINE/CIRCLE/ARC only; Civil objects refused. " +
      "trim/break replace source with new handles. All distances use drawing units. Never guess coordinates." + consent,
    inputSchema: { action: z.enum(["copy", "mirror", "offset", "array", "trim", "break", "extend", "vertices",
      "polyline3d"]),
    handles: z.array(handle).min(1).max(100).optional(), moveBy: point.optional(), axisStart: point.optional(),
    axisEnd: point.optional(), eraseSource: z.boolean().optional(), distance: n.optional(),
    count: n.int().min(2).max(100).optional(), fromDistance: n.nonnegative().optional(),
    toDistance: n.positive().optional(),
    atStart: z.boolean().optional(), point: point.optional(), points: points.optional(),
    bulges: z.array(n).max(1000).optional(), closed: z.boolean().optional(), layer: text.optional() }, annotations
  }, async args => toolResult(await planCivil("geometry.extend", args)));
}

export function registerAnnotationTools(server: McpServer): void {
  server.registerTool("list_blocks", {
    title: "Read existing block definitions and attribute tags",
    description: "Read named definitions, base points and attribute definitions. External references cannot be inserted by these tools.",
    inputSchema: { offset: n.int().nonnegative().default(0), limit: n.int().min(1).max(50).default(20) }, annotations
  }, async args => toolResult(await callPlugin("block.list", args)));
  server.registerTool("plan_annotation", {
    title: "Plan blocks, attributes, associative hatches, multileaders and tables",
    description: "block.create: name/handles/basePoint copies ordinary geometry/text/points into definition, preserving " +
      "originals. block.insert: name/position, optional positive uniform scale/rotationDegrees/attributes/layer. " +
      "block.attributes: handle/attributes exact tags. hatch.create: handles of coplanar closed XY polylines (outer " +
      "first, holes after), pattern (e.g. SOLID), optional patternScale/rotationDegrees/layer. leader.create: text/height/" +
      "arrowPoint/textPosition. table.create: rectangular rows of strings/position/rowHeight/columnWidth/height. " +
      "Use explicit drawing units and content; do not infer material quantities." + consent,
    inputSchema: { operation: z.enum(["block.create", "block.insert", "block.attributes", "hatch.create",
      "leader.create", "table.create"]),
    name: text.optional(), handle: handle.optional(), handles: z.array(handle).min(1).max(1000).optional(),
    basePoint: point.optional(), position: point.optional(), layer: text.optional(), scale: n.positive().optional(),
    rotationDegrees: n.optional(), attributes: z.record(z.string().max(4000)).optional(), pattern: text.optional(),
    patternScale: n.positive().optional(), text: z.string().min(1).max(4000).optional(),
    height: n.positive().optional(),
    arrowPoint: point.optional(), textPosition: point.optional(),
    rows: z.array(z.array(z.string().max(1000)).min(1).max(20)).min(1).max(100).optional(),
    rowHeight: n.positive().optional(), columnWidth: n.positive().optional() }, annotations
  }, async ({ operation, ...args }) => toolResult(await planCivil(operation, args)));
}
