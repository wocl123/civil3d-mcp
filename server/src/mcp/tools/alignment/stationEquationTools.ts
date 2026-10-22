import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { consent } from "../shared/expansionToolsSchemas.js";
import { text, n, annotations } from "../shared/civilToolSchemas.js";
import { z } from "zod";
import { toolResult } from "../../toolResult.js";
import { planCivil } from "../shared/planCivil.js";

export function registerStationEquationTool(server: McpServer): void {
  server.registerTool("plan_alignment_station_equations", {
    title: "Plan replacing the complete alignment station equation collection",
    description: "Read get_alignment station equations first. Replace ALL equations with an explicit ordered list; " +
      "empty list removes all. Each rawStationBack is an interior native raw station (not displayed station after " +
      "equations), stationAhead and type Increasing/Decreasing. Geometry remains, station labels and " +
      "dependent profile/section/corridor interpretation can change. No implicit unit or station conversion." + consent,
    inputSchema: { alignment: text, equations: z.array(z.object({ rawStationBack: n, stationAhead: n,
      type: z.enum(["Increasing", "Decreasing"]) })).max(100) }, annotations
  }, async args => toolResult(await planCivil("alignment.stationEquations", args)));
}
