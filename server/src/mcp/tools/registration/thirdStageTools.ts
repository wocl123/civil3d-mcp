import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerParcelTools } from "../parcel/parcelTools.js";
import { registerPropertyDefinitionTool, registerPropertySetTools } from "../propertySet/propertySetTools.js";
import { registerSuperelevationTool, registerAlignmentEditingTools } from "../alignment/alignmentEditingTools.js";
import { registerCivilWorkflowTool, registerCivilDeleteTool } from "../workflow/civilWorkflowTools.js";
import { registerSurfaceAnalysisTools } from "../surface/surfaceAnalysisTools.js";
import { registerEngineeringAnnotationTools } from "../annotation/engineeringAnnotationTools.js";

// Composition only; tool implementations live in domain modules.
export function registerThirdStageTools(server: McpServer): void {
  registerParcelTools(server);
  registerPropertyDefinitionTool(server);
  registerSuperelevationTool(server);
  registerCivilWorkflowTool(server);
  registerCivilDeleteTool(server);
  registerAlignmentEditingTools(server);
  registerPropertySetTools(server);
  registerSurfaceAnalysisTools(server);
  registerEngineeringAnnotationTools(server);
}
