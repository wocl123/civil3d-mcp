// 설계기준 검토 도구. 비교는 코드가 하고 AI는 결과를 설명만 한다.
// 결과마다 아직 필요한 조건을 "missing"에 적는다. 도구 설명은 AI가 읽으므로 영어로 둔다.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { checkAlignmentCriteria } from "../../criteria/alignmentCriteria.js";
import { checkProfileCriteria } from "../../criteria/profileCriteria.js";
import { checkAllAlignments } from "../../criteria/bulkCheck.js";
import { registerFixes } from "../../changes/changeStore.js";
import { itemsView } from "../fixView.js";
import { toolResult } from "../toolResult.js";
import { CRITERIA_SETS } from "../../criteria/criteriaStore.js";
import { REGIONS, ROAD_CLASSES, SUPERELEVATION_AREAS } from "../../civil/alignmentRecord.js";

// 여러 도구가 같이 쓰는 입력 정의
const key = z.string().min(1).max(255);
const criteria = z.enum(CRITERIA_SETS).optional()
  .describe("Criteria set. Default: the one recorded in the alignment's description, else 도로구조규칙 (국토교통부 law). LH_설계지침_토목 is the LH manual over the law.");
const designSpeed = z.number().int().min(10).max(150).optional()
  .describe("Design speed in km/h. Leave out to use the alignment's design speeds by station.");

export function registerCriteriaTools(server: McpServer): void {
  // 평면선형 하나 검토. 미달 항목의 수정안은 id를 붙여 저장한다(나중에 적용할 수 있게).
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

  // 종단 검토(종단 하나, 또는 선형의 설계 종단 전부). 수정안은 위와 같이 저장한다.
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

  // 전체 선형 일괄 검토(개수와 첫 미달만, 수정안 없음).
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
