import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { name, page, annotations, consent, catalog, point, number, properties, handle } from "../../shared/engineeringToolsSchemas.js";
import { z } from "zod";
import { toolResult } from "../../../toolResult.js";
import { callPlugin } from "../../../../bridge/pluginClient.js";
import { planCivil } from "../../shared/planCivil.js";

export function registerNetworkPartTools(server: McpServer): void {
  server.registerTool("list_pipe_parts", {
    title: "Read gravity network part catalogs",
    description: "With no partsList, lists drawing parts lists. With partsList and kind, lists families. " +
      "With partsList, kind and family, lists exact size names/handles. Follow hasMore. " +
      "Use these exact catalog entries for creation/size changes; never guess family names or a numerical diameter.",
    inputSchema: { partsList: name.optional(), kind: z.enum(["pipe", "structure"]).default("pipe"),
      family: name.optional(), ...page }, annotations
  }, async args => {
    if (args.family && !args.partsList) {
      throw new Error("부품군의 규격을 조회하려면 partsList를 함께 지정하세요.");
    }

    return toolResult(await callPlugin("network.catalog", args));
  });

  server.registerTool("list_pipe_network_parts", {
    title: "Read gravity network parts and connections",
    description: "List pipes/structures of one gravity network: handles, exact family/size, coordinates, centerline " +
      "slope, connected structure handles, rim/sump elevations. Coordinates use WCS drawing units. Follow hasMore.",
    inputSchema: { network: name, kind: z.enum(["pipe", "structure"]).optional(), ...page }, annotations
  }, async args => toolResult(await callPlugin("network.parts", args)));

  registerPipeTools(server);
  registerStructureTools(server);
}

export function registerPipeTools(server: McpServer): void {
  server.registerTool("plan_pipe_create", {
    title: "Plan a gravity pipe with real catalog parts",
    description: "Add a straight gravity pipe (or circular pipe with explicit curveBulge, nonzero abs<=1) to an existing network with a partsList already assigned. " +
      "Use exact catalog family/size, explicit name and WCS start/end CENTERLINE XYZ. Optional startStructure and " +
      "endStructure must be in the same network at matching endpoint XY. Rules are not auto-applied. " +
      "All owned parts/connected labels are checked for locks/references; networks over 1000 inspected entities are refused." + consent,
    inputSchema: { network: name, name, ...catalog, start: point, end: point,
      curveBulge: number.min(-1).max(1).optional(),
      startStructure: name.optional(), endStructure: name.optional(), description: properties.description,
      style: name.optional(), layer: name.optional() }, annotations
  }, async args => toolResult(await planCivil("pipe.create", args)));

  server.registerTool("plan_pipe_edit", {
    title: "Plan gravity pipe geometry, size and connection changes",
    description: "Edit a pipe by exact handle: properties, straight-pipe centerline start/end coordinates, exact catalog " +
      "family+size pair (preserves centerline elevation), connect/disconnect either end. Replacing an existing " +
      "connection requires replaceConnections=true; connecting needs matching endpoint/structure XY. " +
      "Use disconnectStart/End to detach explicitly before moving away. Curved-pipe endpoint edits are refused. " +
      "No nearest-size fallback or automatic design rules. Connected structures/labels may update." + consent,
    inputSchema: { handle, ...properties, family: name.optional(), size: name.optional(), start: point.optional(),
      end: point.optional(), startStructure: name.optional(), endStructure: name.optional(),
      disconnectStart: z.boolean().optional(), disconnectEnd: z.boolean().optional(),
      replaceConnections: z.boolean().optional() }, annotations
  }, async args => toolResult(await planCivil("pipe.edit", args)));
}

export function registerStructureTools(server: McpServer): void {
  server.registerTool("plan_structure_create", {
    title: "Plan a real gravity network structure",
    description: "Create a structure from an exact catalog family/size in an existing gravity network at an explicit " +
      "WCS insertion position. Optional rotationDegrees, rimElevation and sumpElevation. Setting rim disables " +
      "automatic surface rim adjustment; setting sump switches control to elevation. Rules are not auto-applied. " +
      "Does not connect pipes implicitly; use a pipe plan with explicit endpoint connections." + consent,
    inputSchema: { network: name, name, ...catalog, position: point, rotationDegrees: number.optional(),
      rimElevation: number.optional(), sumpElevation: number.optional(), description: properties.description,
      style: name.optional(), layer: name.optional() }, annotations
  }, async args => toolResult(await planCivil("structure.create", args)));

  server.registerTool("plan_structure_edit", {
    title: "Plan gravity structure geometry and property changes",
    description: "Edit a structure by exact handle: name/description/style/layer, exact catalog family+size, WCS " +
      "position, rotationDegrees, rimElevation or sumpElevation. Connected pipes and labels may update. " +
      "Explicit rim turns off automatic surface adjustment, sump uses elevation control; disclose those effects. " +
      "All network parts/connected labels are checked; any locked/reference target blocks the plan." + consent,
    inputSchema: { handle, ...properties, family: name.optional(), size: name.optional(), position: point.optional(),
      rotationDegrees: number.optional(), rimElevation: number.optional(), sumpElevation: number.optional() },
    annotations
  }, async args => toolResult(await planCivil("structure.edit", args)));
}
