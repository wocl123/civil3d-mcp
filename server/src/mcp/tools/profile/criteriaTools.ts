import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { key, criteria, designSpeed } from "../shared/criteriaToolsSchemas.js";
import { z } from "zod";
import { checkProfileCriteria } from "../../../criteria/profileCriteria.js";
import { registerFixes } from "../../../changes/changeStore.js";
import { toolResult } from "../../toolResult.js";
import { itemsView } from "../../fixView.js";

export function registerProfileCriteriaTool(server: McpServer): void {
  server.registerTool("check_profile_criteria", {
    title: "Check profile against design criteria",
    description: "Compare design profiles with design criteria: minimum vertical curve K, required vertical curve length, and maximum grade. Give a profile, or only an alignment to check all of its design profiles. Surface (EG) profiles are skipped. Failed items include computed fixes (longer vertical curve at the same PVI, PVI elevation change, lower grade) with an id, the values to change, their effect on neighbouring curves, and whether they can be applied automatically (applicable).",
    inputSchema: {
      profile: key.optional(), alignment: key.optional(), criteria, designSpeed,
      roadFunction: z.enum(["고속국도", "주간선·보조간선(그 밖의 도로)", "집산도로·연결로", "국지도로"]).optional(),
      terrain: z.enum(["평지", "산지등"]).optional()
    },
    annotations: { readOnlyHint: true, openWorldHint: false }
  }, async args => {
    const reports = await checkProfileCriteria(args);
    await registerFixes(reports.flatMap(report => report.items), { check: "profile", input: args });
    return toolResult(reports.map(report => ({ ...report, items: itemsView(report.items) })));
  });
}
