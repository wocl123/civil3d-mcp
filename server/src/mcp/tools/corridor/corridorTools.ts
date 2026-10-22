import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { consent } from "../shared/extensionToolsSchemas.js";
import { z } from "zod";
import { text, n, point, handle, annotations } from "../shared/civilToolSchemas.js";
import { toolResult } from "../../toolResult.js";
import { planCivil } from "../shared/planCivil.js";

export function registerCorridorTools(server: McpServer): void {
  server.registerTool("plan_corridor_design", {
    title: "Plan assemblies, corridors, baselines, regions, targets and surfaces",
    description: "assembly.create: name/position creates EMPTY assembly; assembly.edit: assembly plus position or " +
      "existing subassembly to attach. corridor.create: name/baselineName/alignment/profile; corridor.baseline adds " +
      "a baseline to corridor. Optional initial region needs assembly/regionName/startStation/endStation. " +
      "Alternatively use featureLine instead of alignment/profile; add its region in a separate later plan. " +
      "corridor.region creates or edits a named region on baselineName: assembly, station range, frequency (tangents), " +
      "curveFrequency/spiralFrequency/profileFrequency, targets from exact logicalName/subassembly shown by inventory " +
      "with explicit target handles (empty array clears). corridor.surface: corridor/name/linkCodes from inventory, " +
      "optional surface style. corridor.rebuild: corridor. " +
      "corridor.split: corridor/baselineName/regionName/station/newName. corridor.removeRegion: same identifiers. " +
      "corridor.solids: corridor/codes from shapeCodes inventory/layer creates selected-code solids in CURRENT drawing. " +
      "corridor.merge: regionName then adjacent otherRegion, same assembly and no targets; first settings win. " +
      "subassembly.parameters: subassembly/parameters [{key,type,value}] from subassemblies inventory. " +
      "Only writable Input parameters. Native API units, no inferred conversions. All affected corridors rebuilt." + consent,
    inputSchema: { operation: z.enum(["assembly.create", "assembly.edit", "corridor.create",
      "corridor.baseline", "corridor.region", "corridor.surface", "corridor.rebuild", "corridor.split",
      "corridor.merge", "corridor.removeRegion", "corridor.solids", "subassembly.parameters"]),
    codes: z.array(text).min(1).max(100).optional(),
    station: n.optional(), newName: text.optional(), otherRegion: text.optional(),
    parameters: z.array(z.object({ key: text, type: z.enum(["double", "integer", "boolean", "string"]),
      value: z.union([n, z.boolean(), z.string().max(4000)]) })).min(1).max(100).optional(),
    name: text.optional(), position: point.optional(), layer: text.optional(), style: text.optional(),
    assembly: text.optional(),
    subassembly: text.optional(), corridor: text.optional(), baselineName: text.optional(),
    featureLine: text.optional(),
    alignment: text.optional(),
    profile: text.optional(), regionName: text.optional(), startStation: n.optional(), endStation: n.optional(),
    frequency: n.positive().optional(), curveFrequency: n.positive().optional(),
    spiralFrequency: n.positive().optional(),
    profileFrequency: n.positive().optional(), linkCodes: z.array(text).min(1).max(100).optional(),
    targets: z.array(z.object({ logicalName: text, subassembly: text,
      handles: z.array(handle).max(100) })).min(1).max(100).optional() }, annotations
  }, async ({ operation, ...args }) => toolResult(await planCivil(operation, args)));
}
