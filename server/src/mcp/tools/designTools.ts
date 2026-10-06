// 설계 도구: 폴리라인 찾기·고르기, 폴리라인으로 선형 계획.
// 계획은 코드가 하고 도면에는 아무것도 그리지 않는다. 사용자가 계획에 동의하면
// AI가 그 id를 apply_drawing_change 에 넘겨 만든다. 도구 설명은 AI가 읽으므로 영어로 둔다.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { callPlugin } from "../../bridge/pluginClient.js";
import { storeFix } from "../../changes/changeStore.js";
import { planAlignmentLayout } from "../../design/alignmentLayout.js";
import { ALIGNMENT_USES, REGIONS, ROAD_CLASSES, SUPERELEVATION_AREAS } from "../../civil/alignmentRecord.js";
import { CRITERIA_SETS } from "../../criteria/criteriaStore.js";
import { fixView } from "../fixView.js";
import { toolResult } from "../toolResult.js";

// 사용자가 폴리라인을 고를 때까지 기다리는 시간(초)
const PICK_SECONDS = 90;

export function registerDesignTools(server: McpServer): void {
  // 2D 폴리라인 목록
  server.registerTool("list_polylines", {
    title: "List 2D polylines",
    description: "Read open and closed 2D polylines in Model Space with handle, layer, vertex count, arc segment count, length, and start and end points, optionally on one layer. Use it to find the polyline an alignment should follow. Results are paged.",
    inputSchema: {
      layer: z.string().min(1).max(255).optional(),
      offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(50).default(20)
    },
    annotations: { readOnlyHint: true, openWorldHint: false }
  }, async args => toolResult(await callPlugin("drawing.polylines", args)));

  // 명령줄에 안내를 띄우고 사용자가 폴리라인을 클릭할 때까지 기다린다
  server.registerTool("pick_polyline", {
    title: "Ask the user to pick a polyline",
    description: "Show a prompt on the Civil 3D command line and wait while the user clicks one 2D polyline in the drawing (up to 90 seconds; ESC cancels). Returns status picked with the polyline (handle, layer, vertices, arcs, length, start and end), or cancelled or timeout. Picking changes nothing. Use it when an alignment should follow a polyline the user has not named by handle.",
    inputSchema: {
      message: z.string().min(1).max(80).optional().describe("Prompt text in Korean. Default: 폴리라인을 선택하세요.")
    },
    annotations: { readOnlyHint: true, openWorldHint: false }
  }, async args => toolResult(await callPlugin("drawing.pick_polyline", { ...args, timeoutSeconds: PICK_SECONDS }, (PICK_SECONDS + 20) * 1000)));

  // 폴리라인으로 선형 계획. 만들 수 있으면 생성 수정안을 id와 함께 저장한다.
  server.registerTool("plan_alignment_from_polyline", {
    title: "Plan an alignment along a polyline",
    description: "Plan, in code, an alignment whose IPs are the polyline's vertices. When uses include 도로 it lays out a road centerline to the design criteria: each IP gets the smallest radius the criteria allow (minimum radius, minimum curve length, spirals from 60 km/h) unless radii are given or the polyline has an arc there; the design speed comes from roadClass and region (제8조, the proviso allows up to 20 km/h less when the user says so by giving designSpeed), the maximum superelevation from the area; what is still needed is listed under missing. The criteria, uses, road class, and areas are written to the alignment's description so later checks use them without asking. Other uses (관망, 수로/하천, 구조물, 기타) get curves only where radii are given or the polyline has arcs. Returns each IP with deflection, straights, radius and why, the radius range that fits (minRadius to maxRadius), spiral, tangent, and status, straights too short for their curves (overlaps), warnings, and an option with an id to create the alignment with apply_drawing_change after the user agrees. Nothing is drawn.",
    inputSchema: {
      polyline: z.string().regex(/^[0-9a-fA-F]{1,16}$/).describe("Polyline handle."),
      uses: z.array(z.enum(ALIGNMENT_USES)).min(1).max(5)
        .describe("What the alignment is for, one or more. With 도로 it is laid out as a road centerline; the uses are written to its Description."),
      name: z.string().min(1).max(100).optional().describe("Alignment name. Leave out for the next free 선형-n."),
      reverse: z.boolean().optional().describe("Run from the polyline's end point to its start point."),
      criteria: z.enum(CRITERIA_SETS).optional()
        .describe("Criteria for a road: 도로구조규칙 (국토교통부 law, default) or LH_설계지침_토목 (LH manual over the law, adds roads inside housing estates)."),
      roadClass: z.enum(ROAD_CLASSES).optional().describe("Road class (제8조). With region, the design speed comes from the criteria."),
      region: z.enum(REGIONS).optional().describe("Area and terrain (제8조). 도시지역 also settles the maximum superelevation."),
      designSpeed: z.number().int().min(10).max(150).optional()
        .describe("Design speed in km/h, only when the user gives one; it is checked against roadClass and region."),
      area: z.enum(SUPERELEVATION_AREAS).optional().describe("Area for the maximum superelevation (제21조), needed in 지방지역."),
      maxSuperelevation: z.union([z.literal(6), z.literal(7), z.literal(8)]).optional(),
      radii: z.array(z.object({ ip: z.number().int().min(1), radius: z.number().min(0).max(100000) })).max(100).optional()
        .describe("Radii the user asked for by IP number; 0 leaves an angle point without a curve.")
    },
    annotations: { readOnlyHint: true, openWorldHint: false }
  }, async args => {
    const { option, source, ...plan } = await planAlignmentLayout(args);
    if (option && source) await storeFix(option, `선형 ${option.create!.name}`, "선형 생성", source);
    return toolResult({ ...plan, ...(option ? { option: fixView(option) } : {}) });
  });
}
