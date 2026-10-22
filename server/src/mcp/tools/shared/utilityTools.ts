import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { n, annotations, text, handle } from "./civilToolSchemas.js";
import { toolResult } from "../../toolResult.js";
import { callPlugin } from "../../../bridge/pluginClient.js";
import { consent } from "./extensionToolsSchemas.js";
import { civilStyleKinds } from "../annotation/civilStyleKinds.js";
import { planCivil } from "./planCivil.js";

export function registerCivilGroupTools(server: McpServer): void {
  server.registerTool("list_civil_groups", {
    title: "List point groups or Sites",
    description: "Read Civil point groups (counts and first 100 point numbers) or Sites. Does not edit survey databases.",
    inputSchema: { kind: z.enum(["pointGroups", "sites"]), offset: n.int().nonnegative().default(0),
      limit: n.int().min(1).max(50).default(20) }, annotations
  }, async args => toolResult(await callPlugin("civil.utility_list", args)));
}

export function registerCivilUtilityTool(server: McpServer): void {
  server.registerTool("plan_civil_utility", {
    title: "Plan point groups, Sites, style copies, COGO deletion and profile edits",
    description: "site.create: name; site.edit: site/newName/description. pointGroup.create: name/query; " +
      "pointGroup.edit: group/query replaces full inclusion query, preserving display order/overrides. Query uses " +
      "Civil number/description/elevation range strings. style.copy: kind/style/name duplicates an existing style. " +
      "cogo.delete: handles (protected survey/project points refused). alignment.offset: alignment/name/offset, " +
      "optional paired startStation/endStation/style/layer creates dynamic offset. profile.pvi: profile/action " +
      "add or edit requires station/elevation, edit/delete require zero-based index; cannot delete end PVIs. " +
      "profileView.range: profileView, paired stationStart/End or elevationMin/Max. Never invent design values." + consent,
    inputSchema: { operation: z.enum(["site.create", "site.edit", "pointGroup.create", "pointGroup.edit",
      "style.copy", "cogo.delete", "alignment.offset", "profile.pvi", "profileView.range"]),
    name: text.optional(), site: text.optional(), newName: text.optional(),
    description: z.string().max(1000).optional(),
    group: text.optional(), kind: z.enum(civilStyleKinds).optional(),
    style: text.optional(), layer: text.optional(), handles: z.array(handle).min(1).max(1000).optional(),
    query: z.object({ all: z.boolean().optional(), includeNumbers: z.string().max(4000).optional(),
      excludeNumbers: z.string().max(4000).optional(), includeDescriptions: z.string().max(4000).optional(),
      excludeDescriptions: z.string().max(4000).optional(), includeElevations: z.string().max(4000).optional(),
      excludeElevations: z.string().max(4000).optional() }).optional(),
    alignment: text.optional(), offset: n.optional(), startStation: n.optional(), endStation: n.optional(),
    profile: text.optional(), action: z.enum(["add", "edit", "delete"]).optional(),
    index: n.int().nonnegative().optional(),
    station: n.optional(), elevation: n.optional(), profileView: text.optional(), stationStart: n.optional(),
    stationEnd: n.optional(), elevationMin: n.optional(), elevationMax: n.optional() }, annotations
  }, async ({ operation, ...args }) => toolResult(await planCivil(operation, args)));
}

export function registerDesignObjectTools(server: McpServer): void {
  server.registerTool("list_design_objects", {
    title: "Read corridor, assembly and section objects",
    description: "Read sampleGroups (available source handles/sampled flags), sampleLines (vertices/sections/views), " +
      "sectionViews, corridors (baselines/regions/targets/code names), assemblies, subassemblies. Follow hasMore.",
    inputSchema: { kind: z.enum(["sampleGroups", "sampleLines", "sectionViews", "corridors", "assemblies",
      "subassemblies"]),
    offset: n.int().nonnegative().default(0), limit: n.int().min(1).max(50).default(20) }, annotations
  }, async args => toolResult(await callPlugin(["sampleGroups", "sampleLines",
    "sectionViews"].includes(args.kind) ? "sections.list" : "corridors.list", args)));
}
