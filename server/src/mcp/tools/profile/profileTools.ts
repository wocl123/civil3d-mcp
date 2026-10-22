import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { number, annotations, consent, name, point, properties, pvi } from "../shared/civilToolsSchemas.js";
import { toolResult } from "../../toolResult.js";
import { callPlugin } from "../../../bridge/pluginClient.js";
import { planCivil } from "../shared/planCivil.js";

export function registerProfileViewTools(server: McpServer): void {
  server.registerTool("list_profile_views", {
    title: "List profile view grids",
    description: "List profile views with name/handle, parent alignment, insertion position, style and layer. " +
      "These are display grids, distinct from profile data. Follow hasMore for all pages.",
    inputSchema: { offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(50).default(50) },
    annotations
  }, async args => toolResult(await callPlugin("profileView.list", args)));

  server.registerTool("plan_profile_view_create", {
    title: "Plan creating a profile view grid",
    description: "Create a single profile view for an existing alignment at an explicit WCS position in drawing units. " +
      "Uses drawing default bands/display options; optional existing style/layer. Does not create profile data, " +
      "split/stack views, change elevations or configure bands. Ask for the insertion position." + consent,
    inputSchema: { name, alignment: name, position: point, description: properties.description,
      style: name.optional(), layer: name.optional() }, annotations
  }, async args => toolResult(await planCivil("profileView.create", args)));

  server.registerTool("plan_profile_view_edit", {
    title: "Plan editing a profile view grid",
    description: "Change a profile view's name, description, existing style/layer or absolute WCS insertion position. " +
      "Does not modify parent alignment, profile elevations, station/elevation ranges or band definitions." + consent,
    inputSchema: { profileView: name, ...properties, position: point.optional() }, annotations
  }, async args => toolResult(await planCivil("profileView.edit", args)));
}

export function registerProfilePlans(server: McpServer): void {
  server.registerTool("plan_profile_create", {
    title: "Plan creating a profile",
    description: "Create a layout (design) profile from strictly increasing station/elevation PVIs, with optional " +
      "symmetric parabolic curveLength on interior PVIs, or a surface (EG) profile from an existing surface. " +
      "Stations are raw metres along the alignment. Ask for missing design elevations, never invent them. " +
      "Creating a profile does not create a profile-view grid." + consent,
    inputSchema: { name, alignment: name, type: z.enum(["layout", "surface"]),
      surface: name.optional(), pvis: z.array(pvi).min(2).max(1000).optional(),
      description: properties.description, style: name.optional(), layer: name.optional(),
      labelSet: name.optional(), offset: number.optional(), startStation: number.optional(),
      endStation: number.optional() }, annotations
  }, async args => toolResult(await planCivil("profile.create", args)));

  server.registerTool("plan_profile_edit", {
    title: "Plan editing a profile",
    description: "Change profile name, description, style or layer. " +
      "For layout profiles, replacePvis replaces ALL geometry with the supplied ordered PVIs and optional curves; " +
      "explicitly describe that replacement. For small numeric fixes prefer existing criteria fixes. " +
      "Surface profiles cannot receive design PVIs." + consent,
    inputSchema: { profile: name, alignment: name.optional(), ...properties,
      replacePvis: z.array(pvi).min(2).max(1000).optional() }, annotations
  }, async args => toolResult(await planCivil("profile.edit", args)));
}
