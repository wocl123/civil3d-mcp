import { callPlugin } from "../../../bridge/pluginClient.js";
import type { Overview } from "../shared/alignmentToolsSchemas.js";
import { INLINE_LIMIT, key } from "../shared/alignmentToolsSchemas.js";
import { readSection } from "../../../civil/shared/civilData.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { toolResult } from "../../toolResult.js";
import { z } from "zod";

export async function profileOverview(profile: string, alignment?: string) {
  const overview = await callPlugin("profile.get", { profile, alignment }) as Overview & { profile: { handle: string; type: string; alignmentHandle?: string } };
  if (overview.profile.type === "EG") {
    return overview;
  }

  const params = { profile: overview.profile.handle, alignment: overview.profile.alignmentHandle };
  const small = (name: string) => (overview.sections[name] ?? 0) <= INLINE_LIMIT;
  const [curves, tangents] = await Promise.all([
    small("curves") ? readSection("profile.section", params, "curves") : undefined,
    small("tangents") ? readSection("profile.section", params, "tangents") : undefined
  ]);
  return { ...overview, ...(curves ? { curves } : {}), ...(tangents ? { tangents } : {}) };
}

export function registerProfileQueryTools(server: McpServer): void {
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
