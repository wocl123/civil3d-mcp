import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { toolResult } from "../../toolResult.js";
import { planCivil } from "../shared/planCivil.js";
import { text, n, point, handle, annotations, civilPlanConsent as consent } from "../shared/civilToolSchemas.js";

export function registerSuperelevationTool(server: McpServer): void {
  server.registerTool("plan_superelevation", {
    title: "Plan native superelevation curves, manual stations and lane/shoulder slopes",
    description: "Read get_alignment_section superelevation and elements first. createCurve only when no " +
      "superelevation curves exist: exact startEntityId/endEntityId. Other actions require exact curve name " +
      "and raw station. addStation creates Manual station; setSlopes updates existing station; removeStation " +
      "only deletes Manual station. setTable: sorted unique stations [{station,slopes}], up to 200 rows, " +
      "upserts Manual stations and updates explicit slopes while preserving unmentioned stations/segments. " +
      "slopes keys are native SuperelevationCrossSegmentType names, e.g. " +
      "LeftOutLaneCrossSlope/RightOutLaneCrossSlope, values rise/run -1..1 (0.06=6%). All eight lane/shoulder " +
      "segments supported. Explicit design values only; does not calculate standards transitions or rebuild " +
      "corridors. Offset/connected/station-equation alignments refused." + consent,
    inputSchema: { alignment: text, action: z.enum(["createCurve", "addStation", "setSlopes", "setTable", "removeStation"]),
      startEntityId: n.int().optional(), endEntityId: n.int().optional(), curve: text.optional(),
      station: n.optional(), slopes: z.record(n.min(-1).max(1)).optional(),
      stations: z.array(z.object({ station: n, slopes: z.record(n.min(-1).max(1)) }))
        .min(1).max(200).optional() }, annotations
  }, async args => toolResult(await planCivil("alignment.superelevation", args)));
}

export function registerAlignmentEditingTools(server: McpServer): void {
  server.registerTool("plan_alignment_from_source", {
    title: "Plan alignment creation preserving actual polyline lines and arcs",
    description: "Existing open XY(z=0) lightweight polyline, name, optional existing alignment style/labelSet/layer. " +
      "Preserves source and bulge arcs. Does not invent tangent radii or spirals. Supports workflow references." + consent,
    inputSchema: { source: handle, name: text, style: text.optional(), labelSet: text.optional(),
      layer: text.optional() },
    annotations
  }, async args => toolResult(await planCivil("alignment.fromPolyline", args)));
  server.registerTool("plan_alignment_geometry", {
    title: "Plan explicit alignment PI and terminal element edits",
    description: "Read get_alignment element IDs first. movePI: only connected fixed-line alignments, vertex index " +
      "0..lineCount and point XY(z=0). appendLine: point; appendArc: midPoint/point; appendSpiral: startRadius/" +
      "endRadius/length/spiralType (default Clothoid, API 0 radius=infinity). removeLast: no extra fields. " +
      "arcRadius: entityId/radius. Keeps alignment handle; rejects connected/offset/equation-bearing alignments and " +
      "shortening below dependent station ranges. Native constraints can reject invalid geometry atomically." + consent,
    inputSchema: { alignment: text, action: z.enum(["movePI", "appendLine", "appendArc", "appendSpiral", "removeLast",
      "arcRadius"]), index: n.int().nonnegative().optional(), point: point.optional(), midPoint: point.optional(),
    entityId: n.int().optional(), radius: n.positive().optional(), startRadius: n.nonnegative().optional(),
    endRadius: n.nonnegative().optional(), length: n.positive().optional(), spiralType: text.optional() }, annotations
  }, async args => toolResult(await planCivil("alignment.geometry", args)));
}
