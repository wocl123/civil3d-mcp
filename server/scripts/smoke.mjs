import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const serverPath = fileURLToPath(new URL("../build/index.js", import.meta.url));
const civilTools = ["get_surface", "list_surfaces", "list_pipe_networks", "plan_pipe_network_delete", "plan_drawing_display", "plan_profile_create",
  "plan_pipe_network_create", "plan_pipe_network_edit", "list_profile_views", "plan_profile_view_create",
  "plan_profile_view_edit", "plan_geometry_edit",
  "list_civil_styles", "list_cogo_points", "plan_cogo_point_create", "plan_cogo_point_edit",
  "get_volume_surface", "plan_volume_surface_create", "plan_volume_surface_edit",
  "list_pipe_parts", "list_pipe_network_parts", "plan_pipe_create", "plan_pipe_edit",
  "plan_structure_create", "plan_structure_edit",
  "plan_profile_edit", "plan_surface_create", "plan_surface_delete", "plan_surface_edit",
  "list_dimensions", "plan_dimension_create", "plan_dimension_edit", "plan_dimension_delete",
  "list_drawing_points", "plan_point_create", "plan_point_edit", "plan_point_delete",
  "inspect_drawing_cleanup", "plan_cleanup_delete", "zoom_drawing", "list_drawing_texts", "plan_text_create",
  "plan_text_edit", "plan_text_delete", "plan_geometry_create", "plan_geometry_delete",
  "plan_alignment_station_equations", "list_pressure_runs", "plan_pressure_run", "list_catchments", "plan_catchment",
  "plan_civil_workflow", "plan_civil_object_delete", "plan_alignment_from_source", "plan_alignment_geometry",
  "list_property_sets", "plan_property_set", "get_surface_analysis", "plan_surface_analysis",
  "plan_engineering_label", "plan_quantity_table", "plan_property_definition", "plan_superelevation", "plan_parcel", "list_parcels",
  "plan_civil_batch", "list_point_metadata", "plan_point_metadata", "plan_network_rules", "plan_cogo_csv_import",
  "list_native_civil_workflows", "plan_native_civil_workflow", "plan_geometry_corner", "plan_layer_properties",
  "plan_geometry_operation", "list_feature_lines", "plan_feature_line_create", "plan_feature_line_edit",
  "list_civil_labels", "plan_civil_label", "plan_surface_definition", "list_pressure_networks", "plan_pressure_design",
  "list_blocks", "plan_annotation", "list_civil_groups", "sample_surface", "plan_civil_utility",
  "list_design_objects", "plan_section_design", "plan_corridor_design"];
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverPath],
  stderr: "pipe"
});
const client = new Client({ name: "my-civil3d-mcp-smoke", version: "0.1.0" });
const timeout = setTimeout(() => {
  process.stderr.write("MCP initialize timed out\n");
  process.exitCode = 1;
  void client.close();
}, 10000);

try {
  await client.connect(transport);
  assert.equal(client.getServerVersion()?.name, "my-civil3d-mcp");
  assert.equal(client.getServerVersion()?.version, "0.1.0");
  assert.ok(client.getServerCapabilities()?.tools);
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map(tool => tool.name).sort(),
    ["apply_drawing_change", "capture_drawing", "check_alignment_criteria", "check_all_alignments", "check_profile_criteria", "get_active_drawing", "get_alignment", "get_alignment_section", "get_drawing_object", "get_drawing_summary", "get_profile", "get_profile_section", "get_selection", "list_alignments", "list_drawing_layers", "list_drawing_objects", "list_polylines", "pick_polyline", "plan_alignment_edit", "plan_alignment_from_polyline", "plan_delete", "plan_layer_create", "plan_layer_delete", "plan_layer_edit", "read_knowledge_rule"].concat(civilTools).sort());
} finally {
  clearTimeout(timeout);
  await client.close();
}

// The palette profile used by the in-app AI exposes read-only tools plus one guarded
// write tool, apply_drawing_change, which applies only computed fixes the user agreed to.
const paletteClient = new Client({ name: "my-civil3d-mcp-smoke", version: "0.1.0" });
await paletteClient.connect(new StdioClientTransport({
  command: process.execPath, args: [serverPath], stderr: "pipe",
  env: { ...process.env, MY_CIVIL3D_MCP_PROFILE: "palette" }
}));
try {
  const paletteTools = (await paletteClient.listTools()).tools;
  assert.deepEqual(paletteTools.map(tool => tool.name).sort(),
    ["apply_drawing_change", "capture_drawing", "check_alignment_criteria", "check_all_alignments", "check_profile_criteria", "get_active_drawing", "get_alignment", "get_alignment_section", "get_drawing_object", "get_drawing_summary", "get_profile", "get_profile_section", "get_selection", "list_alignments", "list_drawing_layers", "list_drawing_objects", "list_polylines", "pick_polyline", "plan_alignment_edit", "plan_alignment_from_polyline", "plan_delete", "plan_layer_create", "plan_layer_delete", "plan_layer_edit", "read_knowledge_rule"].concat(civilTools).sort());
  assert.deepEqual(paletteTools.filter(tool => tool.annotations?.readOnlyHint !== true).map(tool => tool.name), ["apply_drawing_change"]);
  assert.ok(paletteTools.every(tool => tool.annotations?.openWorldHint === false));
} finally {
  await paletteClient.close();
}
process.stdout.write("MCP stdio initialize, full and palette tool discovery OK.\n");
