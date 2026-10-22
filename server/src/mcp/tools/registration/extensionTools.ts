import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerThirdStageTools } from "./thirdStageTools.js";
import { registerExpansionTools } from "./expansionTools.js";
import { registerPressureTools } from "../network/pressure/pressureTools.js";
import { registerAnnotationTools, registerGeometryCornerTool } from "../drawing/extensionTools.js";
import { registerSurfaceExtensions, registerSurfaceSamplingTool } from "../surface/definitionTools.js";
import { registerLabelExtensions } from "../annotation/labelTools.js";
import { registerCivilBatchTool, registerNativeWorkflowTools } from "../workflow/nativeAndBatchTools.js";
import { registerPointMetadataTools, registerPointImportTool } from "../point/metadataTools.js";
import { registerNetworkRuleTool } from "../network/gravity/ruleTools.js";
import { registerFeatureLineTools } from "../featureLine/featureLineTools.js";
import { registerCivilGroupTools, registerCivilUtilityTool, registerDesignObjectTools } from "../shared/utilityTools.js";
import { registerSectionTools } from "../section/sectionTools.js";
import { registerCorridorTools } from "../corridor/corridorTools.js";

export function registerExtensionTools(server: McpServer): void {
  registerThirdStageTools(server);
  registerExpansionTools(server);
  registerDesignExtensions(server);
  registerCivilUtilities(server);
  registerPressureTools(server);
  registerAnnotationTools(server);
  registerSurfaceExtensions(server);
  registerLabelExtensions(server);
  registerCivilBatchTool(server);
  registerPointMetadataTools(server);
  registerNetworkRuleTool(server);
  registerPointImportTool(server);
  registerNativeWorkflowTools(server);
  registerGeometryCornerTool(server);
  registerFeatureLineTools(server);
}

export function registerCivilUtilities(server: McpServer): void {
  registerCivilGroupTools(server);
  registerSurfaceSamplingTool(server);
  registerCivilUtilityTool(server);
}

export function registerDesignExtensions(server: McpServer): void {
  registerDesignObjectTools(server);
  registerSectionTools(server);
  registerCorridorTools(server);
}
