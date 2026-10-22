import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { consent } from "../shared/extensionToolsSchemas.js";
import { z } from "zod";
import { text, annotations, handle } from "../shared/civilToolSchemas.js";
import { toolResult } from "../../toolResult.js";
import { planCivil } from "../shared/planCivil.js";
import { callPlugin } from "../../../bridge/pluginClient.js";

export function registerCivilBatchTool(server: McpServer): void {
  server.registerTool("plan_civil_batch", {
    title: "Plan up to 20 atomic drawing operations in one call",
    description: "Batch independent Civil or drawing plan requests using exact operation names and the same fields as " +
      "their dedicated tools. Existing targets only: later steps cannot refer to objects created by earlier steps. " +
      "No nested batch/workflow, drawing.display or native.assist. All steps revalidated; failure rolls back ALL steps. " +
      "One native Undo restores the batch. Use for multiple requested changes to reduce tool/AI round trips." + consent,
    inputSchema: { steps: z.array(z.object({ operation: text }).catchall(z.unknown())).min(1).max(20) }, annotations
  }, async args => toolResult(await planCivil("batch.apply", args)));
}

export function registerNativeWorkflowTools(server: McpServer): void {
  server.registerTool("list_native_civil_workflows", {
    title: "Read available interactive Civil 3D workflows",
    description: "List locally installed, allowlisted Civil commands for grading, parcels, survey, data shortcuts, " +
      "LandXML, sheets, intersections and superelevation. These require user input in Civil 3D; they are not automatic CRUD.",
    inputSchema: {}, annotations
  }, async () => toolResult(await callPlugin("native.workflows")));

  server.registerTool("plan_native_civil_workflow", {
    title: "Plan opening an interactive Civil 3D workflow",
    description: "Use an exact workflow key from list_native_civil_workflows to open a native tool/wizard. " +
      "Optional exact handles seed selection. This ONLY queues the interactive command: users must supply design values " +
      "and verify results in Civil 3D. Never say objects were created, files exported, references synchronized or " +
      "edits completed from this tool's queued/applied result. Native edits use Civil 3D Undo, not this launch receipt." + consent,
    inputSchema: { workflow: text, handles: z.array(handle).min(1).max(1000).optional() }, annotations
  }, async args => toolResult(await planCivil("native.assist", args)));
}
