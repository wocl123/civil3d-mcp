import { callPlugin } from "../../../bridge/pluginClient.js";
import type { Overview } from "../shared/alignmentToolsSchemas.js";
import { readSection } from "../../../civil/shared/civilData.js";
import { INLINE_LIMIT, key } from "../shared/alignmentToolsSchemas.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { toolResult } from "../../toolResult.js";

export async function alignmentOverview(alignment: string) {
  const overview = await callPlugin("alignment.get", { alignment }) as Overview & { alignment: { handle: string } };
  const params = { alignment: overview.alignment.handle };
  const [related, speeds, curves] = await Promise.all([
    overview.sections.related ? readSection<{ profiles: { name: string; handle: string; type: string }[] }>("alignment.section", params, "related") : [],
    overview.sections.design_speeds ? readSection("alignment.section", params, "design_speeds") : [],
    (overview.sections.curves ?? 0) <= INLINE_LIMIT ? readSection("alignment.section", params, "curves") : undefined
  ]);
  return {
    ...overview,
    profiles: related[0]?.profiles.map(({ name, handle, type }) => ({ name, handle, type })) ?? [],
    designSpeeds: speeds,
    ...(curves ? { curves } : {})
  };
}

export function registerAlignmentQueryTools(server: McpServer): void {
  server.registerTool("list_alignments", {
    title: "List alignments",
    description: "Summarize alignments: name, handle, type, layer, site, start and end station (raw and formatted text), length, and profile count. Results are paged.",
    inputSchema: { offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(200).default(50) },
    annotations: { readOnlyHint: true, openWorldHint: false }
  }, async args => toolResult(await callPlugin("alignment.list", args)));

  server.registerTool("get_alignment", {
    title: "Alignment overview",
    description: "Read one alignment by handle or name, without listing alignments first: summary, settings, the item count of each section, parts Civil 3D could not provide, its profiles (name, handle, type), design speeds, and its curves when there are 30 or fewer. Read other sections with get_alignment_section.",
    inputSchema: { alignment: key },
    annotations: { readOnlyHint: true, openWorldHint: false }
  }, async ({ alignment }) => toolResult(await alignmentOverview(alignment)));

  server.registerTool("get_alignment_section", {
    title: "Alignment section",
    description: "Read one section of an alignment, optionally limited to a raw station range. Sections: curves (one row per horizontal curve group), elements (each line, arc, spiral with Civil 3D values), key_points (geometry and PI points), station_equations, design_speeds, superelevation (critical stations and lane slopes), offset, related (profiles, sample line groups, offset alignments), design_checks (failed checks). Results are paged.",
    inputSchema: {
      alignment: key,
      section: z.enum(["curves", "elements", "key_points", "station_equations", "design_speeds", "superelevation", "offset", "related", "design_checks"]),
      fromStation: z.number().finite().optional(),
      toStation: z.number().finite().optional(),
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(200).default(50)
    },
    annotations: { readOnlyHint: true, openWorldHint: false }
  }, async args => toolResult(await callPlugin("alignment.section", args)));
}
