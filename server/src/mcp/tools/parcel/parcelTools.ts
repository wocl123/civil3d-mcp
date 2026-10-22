import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { callPlugin } from "../../../bridge/pluginClient.js";
import { toolResult } from "../../toolResult.js";
import { planCivil } from "../shared/planCivil.js";
import { text, n, handle, handles, annotations, civilPlanConsent as consent } from "../shared/civilToolSchemas.js";

export function registerParcelTools(server: McpServer): void {
  server.registerTool("list_parcels", {
    title: "Read actual Civil parcels and their Sites",
    description: "Paged exact parcel handles, name, number, address, tax ID, style and containing Site.",
    inputSchema: { offset: n.int().nonnegative().default(0), limit: n.int().min(1).max(50).default(20) }, annotations
  }, async args => toolResult(await callPlugin("parcels.list", args)));
  server.registerTool("plan_parcel", {
    title: "Plan native Civil parcel creation or metadata editing",
    description: "parcel.create: closed, simple XY(z=0) straight lightweight polyline source handle, 3..200 " +
      "vertices, new unique siteName. Creates one real Civil parcel through installed Civil COM API and " +
      "preserves source. Existing Site topology is never modified. parcel.edit: exact parcel handle and " +
      "optional name/address/taxId. Does not subdivide or optimize area. Requires working Civil COM support." + consent,
    inputSchema: { operation: z.enum(["parcel.create", "parcel.edit"]), source: handle.optional(),
      siteName: text.optional(), parcel: handle.optional(), name: text.optional(), address: text.optional(),
      taxId: n.int().optional() }, annotations
  }, async ({ operation, ...args }) => toolResult(await planCivil(operation, args)));
}
