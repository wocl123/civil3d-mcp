import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { callPlugin } from "../../../bridge/pluginClient.js";
import { toolResult } from "../../toolResult.js";
import { planCivil } from "../shared/planCivil.js";

const number = z.number().finite();
const point = z.object({ x: number, y: number, z: number });
const handles = z.array(z.string().regex(/^[0-9a-fA-F]{1,16}$/)).min(1).max(1000);
const name = z.string().min(1).max(255);
const annotations = { readOnlyHint: true, openWorldHint: false };
const page = { offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(50).default(50) };
const consent = " Nothing changes yet. Show exact targets and effects, then ask for agreement before applying the option id.";
const targets = { handles: handles.optional(), all: z.boolean().default(false) };

export function registerPrimitiveTools(server: McpServer): void {
  server.registerTool("list_dimensions", {
    title: "List AutoCAD dimensions", description: "List ordinary dimensions across model/paper layouts, not Civil labels or leaders.",
    inputSchema: page, annotations
  }, async args => toolResult(await callPlugin("dimension.list", args)));

  server.registerTool("plan_dimension_create", {
    title: "Plan an AutoCAD dimension",
    description: "Create an independent, non-associative dimension. Coordinates are WCS in drawing units, on one XY plane. " +
      "For aligned/rotated use start/end extension origins and location for the dimension line; rotationDegrees is required " +
      "for rotated. For radial use start=center and location=point on circle. For diametric use opposite start/end points " +
      "and location=text position. " +
      "For angular use center, start/end ray points and location=arc point. For ordinate use start=feature, location=leader. " +
      "Do not invent definition points, text overrides, style names or offsets." + consent,
    inputSchema: { kind: z.enum(["aligned", "rotated", "radial", "diametric", "angular", "ordinate"]),
      start: point, end: point.optional(), location: point, center: point.optional(),
      rotationDegrees: number.optional(), leaderLength: number.nonnegative().optional(),
      usingXAxis: z.boolean().optional(),
      text: z.string().max(1000).optional(), style: name.optional(), layer: name.optional() }, annotations
  }, async args => toolResult(await planCivil("dimension.create", args)));

  server.registerTool("plan_dimension_edit", {
    title: "Plan dimension property changes",
    description: "Change existing dimension text, text position, style or layer. An empty text restores the measured value. " +
      "A text override changes displayed text, not geometry; explain it explicitly. rotationDegrees only applies to rotated " +
      "dimensions. Locked layers, xrefs and block definitions are refused." + consent,
    inputSchema: { handles, text: z.string().max(1000).optional(), textPosition: point.optional(),
      style: name.optional(), layer: name.optional(), rotationDegrees: number.optional() }, annotations
  }, async args => toolResult(await planCivil("dimension.edit", args)));

  server.registerTool("plan_dimension_delete", {
    title: "Plan deleting ordinary dimensions",
    description: "Delete exact dimension handles, or all=true for ordinary dimensions in model/paper layouts. " +
      "Does not delete Civil labels, leaders, block definitions or source geometry. Locked/xref targets are refused." + consent,
    inputSchema: targets, annotations
  }, async args => toolResult(await planCivil("dimension.delete", args)));

  registerPointTools(server);
  registerTextTools(server);
  registerGeometryTools(server);
  server.registerTool("inspect_drawing_cleanup", {
    title: "Inspect drawing cleanup candidates",
    description: "For trash/junk/unused objects, inspect first without asking for a definition. Scans every object type " +
      "in model/paper layouts, including hidden, off, frozen and locked ones: exact zero-length lines/polylines, empty " +
      "text, extra duplicates of LINE, POINT and block references with identical geometry and display properties, " +
      "block references to empty definitions, empty TIN surfaces and empty alignments. One of each duplicate group is " +
      "kept. Each candidate lists cautions (layer state, hidden, linked data, Civil object) and deletable; explain them. " +
      "No automatic purge or deletion. Reports truncation if scanning reaches 100000 objects.",
    inputSchema: page, annotations
  }, async args => toolResult(await callPlugin("drawing.cleanup", args, 120000)));

  server.registerTool("plan_cleanup_delete", {
    title: "Plan deleting inspected cleanup candidates",
    description: "After inspection and the user choosing candidates, plan deleting their exact handles. Rechecks that every " +
      "target is still a candidate; deletable=false candidates (locked layer, Civil objects) are refused. " +
      "Does not purge definitions or infer design intent." + consent,
    inputSchema: { handles }, annotations
  }, async args => toolResult(await planCivil("cleanup.delete", args)));

  server.registerTool("zoom_drawing", {
    title: "Zoom the drawing view",
    description: "Zoom the current view to object handles (for example objects just created), to a WCS window min/max, " +
      "or to a center point. Use exactly one of handles, window or center. size is the minimum view size in drawing " +
      "units (default 10) so a point or tiny object is still visible. Changes only the view, never drawing data, so " +
      "no plan or agreement is needed; it is not an undo step.",
    inputSchema: { handles: handles.optional(), window: z.object({ min: point, max: point }).optional(),
      center: point.optional(), size: number.positive().optional() }, annotations
  }, async args => toolResult(await callPlugin("drawing.zoom", args)));
}

function registerTextTools(server: McpServer): void {
  server.registerTool("list_drawing_texts", {
    title: "List single-line and multiline text",
    description: "List TEXT/MTEXT in model/paper layouts with content (formatting removed, 200 chars max), height, " +
      "rotation, style, colour, layer and position, plus counts by kind and layer. Filter by layer and/or contains. " +
      "Block attributes, dimension text and Civil labels are not included.",
    inputSchema: { ...page, layer: name.optional(), contains: z.string().min(1).max(255).optional() }, annotations
  }, async args => toolResult(await callPlugin("text.list", args)));

  server.registerTool("plan_text_create", {
    title: "Plan creating text",
    description: "Create one single-line (kind=single, default) or multiline (kind=multi) text at a WCS position. " +
      "height defaults to the drawing TEXTSIZE; style and layer must exist. Do not invent content." + consent,
    inputSchema: { kind: z.enum(["single", "multi"]).optional(), content: z.string().min(1).max(1000), position: point,
      height: number.positive().optional(), rotationDegrees: number.optional(), style: name.optional(),
      layer: name.optional() }, annotations
  }, async args => toolResult(await planCivil("text.create", args)));

  server.registerTool("plan_text_edit", {
    title: "Plan editing text",
    description: "Change TEXT/MTEXT content (replace all, or find+replace), height, rotation, style, layer, ACI colour " +
      "(0 ByBlock, 256 ByLayer), absolute position (one text) or moveBy. Target exact handles, or all=true with " +
      "optional layer/contains filters. Replacing all MTEXT content drops its inline formatting; say so." + consent,
    inputSchema: { ...targets, layer: name.optional(), contains: z.string().min(1).max(255).optional(),
      content: z.string().min(1).max(1000).optional(), find: z.string().min(1).max(255).optional(),
      replace: z.string().max(1000).optional(), height: number.positive().optional(),
      rotationDegrees: number.optional(), style: name.optional(), newLayer: name.optional(),
      color: z.number().int().min(0).max(256).optional(), position: point.optional(), moveBy: point.optional() },
    annotations
  }, async args => toolResult(await planCivil("text.edit", textEdit(args))));

  server.registerTool("plan_text_delete", {
    title: "Plan deleting text",
    description: "Delete exact TEXT/MTEXT handles, or all=true with optional layer/contains filters. Block attributes, " +
      "dimension text and Civil labels are not deleted." + consent,
    inputSchema: { ...targets, layer: name.optional(), contains: z.string().min(1).max(255).optional() }, annotations
  }, async ({ layer, ...args }) => toolResult(await planCivil("text.delete",
    { ...args, ...(layer === undefined ? {} : { filterLayer: layer }) })));
}

// layer는 대상 조건, newLayer는 바꿀 레이어다. 플러그인 요청에서는 layer 하나로 쓴다.
function textEdit(args: Record<string, unknown>): Record<string, unknown> {
  if (args.find !== undefined && args.replace === undefined) {
    throw new Error("찾아 바꾸기에는 replace 값이 필요합니다.");
  }

  const { layer, newLayer, ...rest } = args;
  if (layer !== undefined && args.all !== true) {
    throw new Error("layer 조건은 all=true와 함께 씁니다. 레이어를 바꾸려면 newLayer를 쓰세요.");
  }

  return { ...rest, ...(layer === undefined ? {} : { filterLayer: layer }),
    ...(newLayer === undefined ? {} : { layer: newLayer }) };
}

function registerGeometryTools(server: McpServer): void {
  server.registerTool("plan_geometry_edit", {
    title: "Plan editing ordinary shapes",
    description: "Edit exact LINE, lightweight polyline, circle or arc handles while preserving handles. " +
      "Set circle/arc radius, uniformly scale, rotate around WCS Z, translate by WCS moveBy, change existing layer " +
      "or ACI color (0 ByBlock, 256 ByLayer). Order: set radius, scale, rotate, move. " +
      "basePoint is required for scale/rotation. Refuses Civil objects, blocks, locked layers and xrefs." + consent,
    inputSchema: { handles, moveBy: point.optional(), basePoint: point.optional(), rotationDegrees: number.optional(),
      scale: number.positive().optional(), radius: number.positive().optional(), layer: name.optional(),
      color: z.number().int().min(0).max(256).optional() }, annotations
  }, async args => toolResult(await planCivil("geometry.edit", args)));

  server.registerTool("plan_geometry_create", {
    title: "Plan drawing a basic shape",
    description: "Draw one LINE (points: 2), lightweight polyline (points: 2-1000, optional closed), axis-aligned " +
      "rectangle (points: two opposite corners, or one corner plus width/height), circle (center, radius) or arc " +
      "(center, radius, startAngleDegrees, endAngleDegrees counter-clockwise from +X). WCS drawing units; all points " +
      "share one Z. Ask for missing sizes; never invent them. After applying, zoom_drawing with the created handle " +
      "shows it." + consent,
    inputSchema: { kind: z.enum(["line", "polyline", "rectangle", "circle", "arc"]),
      points: z.array(point).min(1).max(1000).optional(), closed: z.boolean().optional(),
      width: number.optional(), height: number.optional(), center: point.optional(),
      radius: number.positive().optional(), startAngleDegrees: number.optional(),
      endAngleDegrees: number.optional(), layer: name.optional() }, annotations
  }, async args => toolResult(await planCivil("geometry.create", args)));

  server.registerTool("plan_geometry_delete", {
    title: "Plan deleting basic shapes",
    description: "Delete exact LINE, lightweight polyline, circle or arc handles (for example a shape drawn earlier). " +
      "Civil objects, blocks and other types are refused." + consent,
    inputSchema: { handles }, annotations
  }, async args => toolResult(await planCivil("geometry.delete", args)));
}

function registerPointTools(server: McpServer): void {
  server.registerTool("list_drawing_points", {
    title: "List ordinary drawing POINT objects", description: "List AutoCAD POINT coordinates, not COGO points or TIN vertices.",
    inputSchema: page, annotations
  }, async args => toolResult(await callPlugin("point.list", args)));

  server.registerTool("plan_point_create", {
    title: "Plan drawing points at coordinates or vertices",
    description: "Create ordinary AutoCAD POINT objects from either explicit WCS XYZ points or verticesOf LINE/2D/3D " +
      "polyline handles. Use the supplied selection handle directly for corners/vertices; let code read geometry. " +
      "Deduplicates exact XYZ coordinates, including closed-polyline closing vertices, up to 1000 points. " +
      "Does not create surveying COGO points or modify TIN geometry. Global point display settings stay unchanged." + consent,
    inputSchema: { points: z.array(point).min(1).max(1000).optional(), verticesOf: handles.optional(),
      layer: name.optional() }, annotations
  }, async args => toolResult(await planCivil("point.create", args)));

  server.registerTool("plan_point_edit", {
    title: "Plan moving or changing ordinary drawing points",
    description: "Change one AutoCAD POINT's absolute position, or translate one/many by moveBy WCS XYZ, or change layer. " +
      "Do not combine position and moveBy. COGO points and TIN vertices are not accepted." + consent,
    inputSchema: { handles, position: point.optional(), moveBy: point.optional(), layer: name.optional() }, annotations
  }, async args => toolResult(await planCivil("point.edit", args)));

  server.registerTool("plan_point_delete", {
    title: "Plan deleting ordinary drawing points",
    description: "Delete specified AutoCAD POINT handles or all=true for POINT objects across model/paper layouts. " +
      "COGO points, TIN vertices and block contents are not deleted." + consent,
    inputSchema: targets, annotations
  }, async args => toolResult(await planCivil("point.delete", args)));
}
