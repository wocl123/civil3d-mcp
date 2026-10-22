import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { civilStyleKinds } from "./civilStyleKinds.js";
import { page, annotations } from "../shared/engineeringToolsSchemas.js";
import { toolResult } from "../../toolResult.js";
import { callPlugin } from "../../../bridge/pluginClient.js";

export function registerCivilStyleTools(server: McpServer): void {
  server.registerTool("list_civil_styles", {
    title: "List existing Civil styles",
    description: "Read available style names/handles before creating or editing Civil objects. Point-label styles are " +
      "top-level styles. Does not create or import styles.",
    inputSchema: { kind: z.enum(civilStyleKinds), ...page }, annotations
  }, async args => toolResult(await callPlugin("civil.styles", args)));
}
