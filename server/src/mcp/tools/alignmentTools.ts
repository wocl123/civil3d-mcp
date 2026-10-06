import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { callPlugin } from "../../bridge/pluginClient.js";
import { readSection } from "../../civil/civilData.js";
import { toolResult } from "../toolResult.js";

const key = z.string().min(1).max(255);
// Sections this small are included in the overview, saving the AI a second call.
const INLINE_LIMIT = 30;

type Overview = { sections: Record<string, number> };

async function alignmentOverview(alignment: string) {
  const overview = await callPlugin("alignment.get", { alignment }) as Overview & { alignment: { handle: string } };
  const params = { alignment: overview.alignment.handle };
  const [related, speeds, curves] = await Promise.all([
    overview.sections.related ? readSection<{ profiles: { name: string; handle: string; type: string }[] }>("alignment.section", params, "related") : [],
    overview.sections.design_speeds ? readSection("alignment.section", params, "design_speeds") : [],
    (overview.sections.curves ?? 0) <= INLINE_LIMIT ? readSection("alignment.section", params, "curves") : undefined
  ]);
  return {
    ...overview,
    profiles: related[0]?.profiles.map(profile => ({ name: profile.name, handle: profile.handle, type: profile.type })) ?? [],
    designSpeeds: speeds,
    ...(curves ? { curves } : {})
  };
}

async function profileOverview(profile: string, alignment?: string) {
  const overview = await callPlugin("profile.get", { profile, alignment }) as Overview & { profile: { handle: string; type: string; alignmentHandle?: string } };
  if (overview.profile.type === "EG") return overview;
  const params = { profile: overview.profile.handle, alignment: overview.profile.alignmentHandle };
  const small = (name: string) => (overview.sections[name] ?? 0) <= INLINE_LIMIT;
  const [curves, tangents] = await Promise.all([
    small("curves") ? readSection("profile.section", params, "curves") : undefined,
    small("tangents") ? readSection("profile.section", params, "tangents") : undefined
  ]);
  return { ...overview, ...(curves ? { curves } : {}), ...(tangents ? { tangents } : {}) };
}

export function registerAlignmentTools(server: McpServer): void {
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

  server.registerTool("get_profile", {
    title: "Profile overview",
    description: "Read one profile by handle or name (give the alignment when names repeat): summary, settings (data source surface, offset, design checks), highest and lowest points, the item count of each section, parts Civil 3D could not provide, and for design profiles its vertical curves and tangents when each has 30 or fewer. Read other sections with get_profile_section.",
    inputSchema: { profile: key, alignment: key.optional() },
    annotations: { readOnlyHint: true, openWorldHint: false }
  }, async ({ profile, alignment }) => toolResult(await profileOverview(profile, alignment)));

  server.registerTool("get_profile_section", {
    title: "Profile section",
    description: "Read one section of a profile, optionally limited to a raw station range. Sections: pvis (station, elevation, grades in percent, curve length, K, sight distances), tangents (grade and length of each straight grade), curves (vertical curves with crest or sag, K, grade change, high or low point, minimum K), views (profile views of the alignment), design_checks (failed checks), elevations (elevation and grade at the given stations, or every interval over the range; up to 200). Results are paged.",
    inputSchema: {
      profile: key,
      alignment: key.optional(),
      section: z.enum(["pvis", "tangents", "curves", "views", "design_checks", "elevations"]),
      fromStation: z.number().finite().optional(),
      toStation: z.number().finite().optional(),
      stations: z.array(z.number().finite()).max(200).optional(),
      interval: z.number().positive().finite().optional(),
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(200).default(50)
    },
    annotations: { readOnlyHint: true, openWorldHint: false }
  }, async args => toolResult(await callPlugin("profile.section", args)));
}
