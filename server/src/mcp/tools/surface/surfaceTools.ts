import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { number, annotations, name, consent, properties, surfaceData } from "../shared/civilToolsSchemas.js";
import { toolResult } from "../../toolResult.js";
import { callPlugin } from "../../../bridge/pluginClient.js";
import { planCivil } from "../shared/planCivil.js";

export function registerSurfaceTools(server: McpServer): void {
  server.registerTool("list_surfaces", {
    title: "List Civil surfaces", description: "List surfaces by name and handle, with type, style and layer. Paged.",
    inputSchema: { offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(50).default(20) },
    annotations
  }, async args => toolResult(await callPlugin("surface.list", args)));

  server.registerTool("get_surface", {
    title: "Read a Civil surface", description: "Read surface properties, TIN statistics and dependent object references.",
    inputSchema: { surface: name }, annotations
  }, async args => toolResult(await callPlugin("surface.get", args)));

  server.registerTool("plan_surface_create", {
    title: "Plan creating a TIN surface",
    description: "Create a TIN surface from explicit XYZ points and/or 3D breaklines, optionally an outer boundary. " +
      "Ask for missing elevations; never invent terrain. Empty surfaces are allowed when requested. " +
      "Style and layer must already exist. Coordinates and elevations use drawing units." + consent,
    inputSchema: { name, description: properties.description, style: name.optional(), layer: name.optional(),
      ...surfaceData }, annotations
  }, async args => toolResult(await planCivil("surface.create", args)));

  server.registerTool("plan_surface_edit", {
    title: "Plan editing a TIN surface",
    description: "Rename, change description/style/layer, add XYZ vertices, standard breaklines or an outer boundary, " +
      "delete vertices by exact XY, raise/lower by elevationDelta or rebuild a TIN surface. " +
      "Operations run in that order: delete vertices, add geometry/boundary, raise, rebuild. " +
      "Dependencies can update; reference surfaces cannot be edited." + consent,
    inputSchema: { surface: name, ...properties, ...surfaceData,
      deleteVertices: z.array(z.object({ x: number, y: number })).min(1).max(1000).optional(),
      elevationDelta: number.optional(), rebuild: z.boolean().optional() }, annotations
  }, async args => toolResult(await planCivil("surface.edit", args)));

  server.registerTool("plan_surface_delete", {
    title: "Plan deleting a surface",
    description: "Delete one surface, an explicit surfaces list, or every surface whose name contains nameContains. " +
      "Use exactly one selector; a matching-name request is planned in one call, not repeated per surface. " +
      "Refuse the whole plan if a target has dependent references; remove or detach those first. " +
      "Never silently delete dependent design objects." + consent,
    inputSchema: { surface: name.optional(), surfaces: z.array(name).min(1).max(100).optional(),
      nameContains: name.optional() }, annotations
  }, async args => {
    const selectors = [args.surface, args.surfaces, args.nameContains].filter(value => value !== undefined);
    if (selectors.length !== 1) {
      throw new Error("지표면 하나, 지표면 목록 또는 이름 포함 조건 중 하나를 지정하세요.");
    }

    return toolResult(await planCivil(args.surface ? "surface.delete" : "surface.deleteMany", args));
  });
}
