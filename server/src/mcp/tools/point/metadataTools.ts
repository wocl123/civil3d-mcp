import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { n, annotations, text, handle } from "../shared/civilToolSchemas.js";
import { toolResult } from "../../toolResult.js";
import { callPlugin } from "../../../bridge/pluginClient.js";
import { consent } from "../shared/extensionToolsSchemas.js";
import { planCivil } from "../shared/planCivil.js";

export function registerPointMetadataTools(server: McpServer): void {
  server.registerTool("list_point_metadata", {
    title: "Read description-key sets and point UDP schemas",
    description: "Read description-key set handles, key codes/formats/style flags, or point UDP classifications/types/GUIDs.",
    inputSchema: { kind: z.enum(["descriptionKeys", "udps"]), offset: n.int().nonnegative().default(0),
      limit: n.int().min(1).max(50).default(20) }, annotations
  }, async args => toolResult(await callPlugin("point.metadata", args)));

  server.registerTool("plan_point_metadata", {
    title: "Plan description keys, explicit key application and point UDP values",
    description: "descriptionSet.create: name. descriptionKey.set: set (name/handle), code plus format/style/labelStyle/layer " +
      "creates or edits a key; existing points unchanged. cogo.descriptionKeys: handles explicitly reapplies current key " +
      "search order and can change styles/layers/rotations/scales/full descriptions. pointUdp.create: classification/name/type " +
      "(string/double/integer/boolean), creates classification if absent. cogo.udp: handles/classification/name/value edits " +
      "existing UDP values only. Survey/project/locked points refused. Read metadata and actual styles before planning." + consent,
    inputSchema: { operation: z.enum(["descriptionSet.create", "descriptionKey.set", "cogo.descriptionKeys",
      "pointUdp.create", "cogo.udp"]),
    name: text.optional(), set: text.optional(), code: text.optional(), format: z.string().max(4000).optional(),
    style: text.optional(), labelStyle: text.optional(), layer: text.optional(),
    handles: z.array(handle).min(1).max(1000).optional(),
    classification: text.optional(), type: z.enum(["string", "double", "integer", "boolean"]).optional(),
    value: z.union([z.string().max(4000), n, z.boolean()]).optional() }, annotations
  }, async ({ operation, ...args }) => toolResult(await planCivil(operation, args)));
}

export function registerPointImportTool(server: McpServer): void {
  server.registerTool("plan_cogo_csv_import", {
    title: "Plan COGO point import from UTF-8 CSV",
    description: "Read an existing absolute CSV path with header number,x,y,z,description and at most 1000 rows. " +
      "Explicit WCS drawing units, dot decimals; quoted descriptions supported. Duplicate numbers reject entire import. " +
      "File contents are fingerprinted and parsed again before apply. Does not transform coordinates or apply description keys." + consent,
    inputSchema: { path: z.string().min(1).max(4096), style: text.optional(), labelStyle: text.optional(),
      layer: text.optional() }, annotations
  }, async args => toolResult(await planCivil("cogo.import", args)));
}
