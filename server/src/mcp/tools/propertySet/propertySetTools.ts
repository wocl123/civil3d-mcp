import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { callPlugin } from "../../../bridge/pluginClient.js";
import { toolResult } from "../../toolResult.js";
import { planCivil } from "../shared/planCivil.js";
import { text, n, handle, handles, annotations, civilPlanConsent as consent } from "../shared/civilToolSchemas.js";

export function registerPropertyDefinitionTool(server: McpServer): void {
  server.registerTool("plan_property_definition", {
    title: "Plan manual property-set definition creation or additive schema extension",
    description: "create: new unique name, appliesTo exact RX class names (e.g. AcDbLine), properties " +
      "[{name,type:Text|Integer|Real|TrueFalse,default:typedValue}]. add: existing definition name and new " +
      "properties only. Preserves existing property IDs, types and attached values. Object-based manual " +
      "definitions only; no formula/automatic fields or destructive schema changes." + consent,
    inputSchema: { action: z.enum(["create", "add"]), name: text,
      appliesTo: z.array(text).min(1).max(50).optional(), properties: z.array(z.object({ name: text,
        type: z.enum(["Text", "Integer", "Real", "TrueFalse"]),
        default: z.union([z.string().max(4000), n, z.boolean()]) })).min(1).max(100) }, annotations
  }, async args => toolResult(await planCivil("propertyDefinition.change", args)));
}

export function registerPropertySetTools(server: McpServer): void {
  server.registerTool("list_property_sets", {
    title: "Read actual property-set definitions or attached values",
    description: "No handle: paged actual definitions with property names/types/units/automatic/read-only flags. " +
      "handle: property sets and values attached to that exact drawing entity.",
    inputSchema: { handle: handle.optional(), offset: n.int().nonnegative().default(0),
      limit: n.int().min(1).max(50).default(20) }, annotations
  }, async args => toolResult(await callPlugin("propertySets.list", args)));
  server.registerTool("plan_property_set", {
    title: "Plan property-set attachment, detachment or typed manual value updates",
    description: "Read actual definitions first. Exact definition name/handle and entity handles. attach adds an " +
      "existing object-based definition; detach removes its stored manual values; set requires existing attachment " +
      "and values {exactPropertyName:value}. Only writable manual Text/Integer/Real/TrueFalse supported. " +
      "No automatic data overwrite, style-based sets or implicit unit conversions." + consent,
    inputSchema: { action: z.enum(["attach", "detach", "set"]), definition: text, handles,
      values: z.record(z.union([z.string().max(4000), n, z.boolean()])).optional() }, annotations
  }, async args => toolResult(await planCivil("propertySet.change", args)));
}
