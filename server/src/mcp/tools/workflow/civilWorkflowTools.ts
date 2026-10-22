import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { toolResult } from "../../toolResult.js";
import { planCivil } from "../shared/planCivil.js";
import { text, handles, annotations, civilPlanConsent as consent } from "../shared/civilToolSchemas.js";

export function registerCivilWorkflowTool(server: McpServer): void {
  server.registerTool("plan_civil_workflow", {
    title: "Plan a dependent creation workflow with prior-step handle references",
    description: "Up to 12 steps {id,request:{operation,...}}. Target fields may use {$ref:'step.handle'} or " +
      "{$ref:'step.created.0'} from an EARLIER step. Only bounded geometry/alignment.fromPolyline/profile/surface/" +
      "featureLine/assembly/network/pressureNetwork/sampleGroup/sampleLine/sectionView/COGO creation and corridor " +
      "create/baseline/region/surface/rebuild, propertyDefinition.change and propertySet.change supported. " +
      "Definition handle references use the definition field. No native commands, files, deletion or nested workflows. " +
      "Example polyline -> alignment.fromPolyline source ref -> profile.create alignment ref -> corridor.create " +
      "alignment/profile refs. Explicit names/design values/styles. Whole sequence is simulated under rollback " +
      "before agreement; apply revalidates and commits atomically, one Undo. Entire drawing revision is bound." + consent,
    inputSchema: { steps: z.array(z.object({ id: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,31}$/),
      request: z.object({ operation: text }).catchall(z.unknown()) })).min(1).max(12) }, annotations
  }, async args => toolResult(await planCivil("workflow.apply", args)));
}

export function registerCivilDeleteTool(server: McpServer): void {
  server.registerTool("plan_civil_object_delete", {
    title: "Plan guarded deletion of feature lines, sections, catchments or pressure parts",
    description: "Exact handles matching kind. sampleLine/sampleGroup with owned sections/views require explicit " +
      "includeDependents=true. External dependents and locked/reference objects refuse the whole plan. " +
      "Feature lines in Sites or used by corridors/overlapping surface breaklines refused conservatively. " +
      "Pressure parts must be outside runs and disconnected from unselected parts. For runs use plan_pressure_run." + consent,
    inputSchema: { kind: z.enum(["featureLine", "sampleLine", "sampleGroup", "sectionView", "catchment", "pressurePart"]),
      handles, includeDependents: z.boolean().default(false) }, annotations
  }, async args => toolResult(await planCivil("civilObject.delete", args)));
}
