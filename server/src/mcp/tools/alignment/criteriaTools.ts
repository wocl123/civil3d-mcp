import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { key, criteria, designSpeed } from "../shared/criteriaToolsSchemas.js";
import { z } from "zod";
import { SUPERELEVATION_AREAS, ROAD_CLASSES, REGIONS } from "../../../civil/alignment/alignmentRecord.js";
import { checkAlignmentCriteria } from "../../../criteria/alignmentCriteria.js";
import { registerFixes } from "../../../changes/changeStore.js";
import { toolResult } from "../../toolResult.js";
import { itemsView } from "../../fixView.js";
import { checkAllAlignments } from "../../../criteria/bulkCheck.js";

export function registerAlignmentCriteriaTool(server: McpServer): void {
  server.registerTool("check_alignment_criteria", {
    title: "Check alignment against design criteria",
    description: "Compare one alignment with design criteria: design speed for the road class and area, minimum curve radius, minimum curve length, spiral presence and length, and maximum superelevation. Returns each comparison with actual value, limit, article, and pass, fail, or n/a, plus conditions still needed. Failed items include computed fixes (larger radius, longer curve, added spirals) with an id, the values to change, whether they fit between neighbouring elements, and whether they can be applied automatically (applicable).",
    inputSchema: {
      alignment: key, criteria, designSpeed,
      maxSuperelevation: z.union([z.literal(6), z.literal(7), z.literal(8)]).optional()
        .describe("Maximum superelevation (%) the design applies. Leave out to use the area's maximum."),
      area: z.enum(SUPERELEVATION_AREAS).optional(),
      roadClass: z.enum(ROAD_CLASSES).optional().describe("Road class, to check the design speed (제8조). Leave out to use the one recorded on the alignment."),
      region: z.enum(REGIONS).optional()
    },
    annotations: { readOnlyHint: true, openWorldHint: false }
  }, async args => {
    const report = await checkAlignmentCriteria(args);
    await registerFixes(report.items, { check: "alignment", input: args });
    return toolResult({ ...report, items: itemsView(report.items) });
  });
}

export function registerBulkCriteriaTool(server: McpServer): void {
  server.registerTool("check_all_alignments", {
    title: "Check every alignment against design criteria",
    description: "One call for the whole drawing: checks every alignment (and, unless profiles is false, its design profiles) with the same code as check_alignment_criteria and check_profile_criteria, using the conditions recorded on each alignment. Returns per alignment the pass, fail, review, and not-checked counts, conditions still missing, and the first failures, plus totals. Use it for questions about all alignments instead of calling the single checks one by one. It makes no fixes: for an alignment's details and fixes, call the single check on that alignment. Up to 60 alignments per call; continue from nextOffset.",
    inputSchema: {
      criteria, profiles: z.boolean().default(true).describe("Also check each alignment's design profiles."),
      offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(60).default(60)
    },
    annotations: { readOnlyHint: true, openWorldHint: false }
  }, async args => toolResult(await checkAllAlignments(args)));
}
