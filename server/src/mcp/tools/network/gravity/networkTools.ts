import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { consent, name, properties, annotations, number } from "../../shared/civilToolsSchemas.js";
import { toolResult } from "../../../toolResult.js";
import { planCivil } from "../../shared/planCivil.js";
import { z } from "zod";
import { callPlugin } from "../../../../bridge/pluginClient.js";

export function registerNetworkContainerPlans(server: McpServer): void {
  server.registerTool("plan_pipe_network_create", {
    title: "Plan creating an empty gravity pipe network",
    description: "Create an EMPTY gravity network container with name, description, existing layer and optional " +
      "reference alignment/surface and existing partsList (query list_pipe_parts). Does not place pipes or structures; " +
      "use dedicated part plans after creating the container. " +
      "Pressure networks are not supported." + consent,
    inputSchema: { name, description: properties.description, layer: name.optional(),
      partsList: name.optional(),
      referenceAlignment: name.optional(), referenceSurface: name.optional() }, annotations
  }, async args => toolResult(await planCivil("network.create", args)));

  server.registerTool("plan_pipe_network_edit", {
    title: "Plan gravity pipe network property changes",
    description: "Change one gravity network's name, description, container layer or reference alignment/surface. " +
      "Can assign an existing partsList without swapping existing parts. " +
      "Keeps all pipes/structures and their geometry, sizes, connectivity and layers. " +
      "Reference networks and locked container layers are refused. Does not edit part geometry or pressure networks." + consent,
    inputSchema: { network: name, newName: name.optional(), description: properties.description,
      partsList: name.optional(),
      layer: name.optional(), referenceAlignment: name.optional(), referenceSurface: name.optional() }, annotations
  }, async args => toolResult(await planCivil("network.edit", args)));
}

export function registerNetworkInventoryTools(server: McpServer): void {
  server.registerTool("list_pipe_networks", {
    title: "List pipe networks",
    description: "Search ALL gravity pipe networks, including those omitted from the drawing summary. " +
      "Returns names, handles, layers, pipe/structure counts and reference status. Filter before paging; follow hasMore.",
    inputSchema: { nameContains: name.optional(), offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(50).default(50) }, annotations
  }, async args => toolResult(await callPlugin("network.list", args)));

  server.registerTool("plan_pipe_network_delete", {
    title: "Plan deleting pipe networks",
    description: "Delete a gravity pipe network by exact name/handle, an explicit networks list, or ALL networks " +
      "whose names contain nameContains, including numbered names. Use exactly one selector. " +
      "Includes every owned pipe, structure and connected label on any layer; preserves layers and other networks. " +
      "References or locked targets block the entire batch. Pressure networks are not supported." + consent,
    inputSchema: { network: name.optional(), networks: z.array(name).min(1).max(100).optional(),
      nameContains: name.optional() }, annotations
  }, async args => {
    if ([args.network, args.networks, args.nameContains].filter(value => value !== undefined).length !== 1) {
      throw new Error("관망 하나, 관망 목록 또는 이름 포함 조건 중 하나를 지정하세요.");
    }

    return toolResult(await planCivil("network.delete", args));
  });
}
