import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const serverPath = fileURLToPath(new URL("../build/index.js", import.meta.url));
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
    ["apply_drawing_change", "capture_drawing", "check_alignment_criteria", "check_all_alignments", "check_profile_criteria", "get_active_drawing", "get_alignment", "get_alignment_section", "get_drawing_object", "get_drawing_summary", "get_profile", "get_profile_section", "get_selection", "list_alignments", "list_drawing_layers", "list_drawing_objects", "list_polylines", "pick_polyline", "plan_alignment_from_polyline", "read_knowledge_rule"]);
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
    ["apply_drawing_change", "capture_drawing", "check_alignment_criteria", "check_all_alignments", "check_profile_criteria", "get_active_drawing", "get_alignment", "get_alignment_section", "get_drawing_object", "get_drawing_summary", "get_profile", "get_profile_section", "get_selection", "list_alignments", "list_drawing_layers", "list_drawing_objects", "list_polylines", "pick_polyline", "plan_alignment_from_polyline", "read_knowledge_rule"]);
  assert.deepEqual(paletteTools.filter(tool => tool.annotations?.readOnlyHint !== true).map(tool => tool.name), ["apply_drawing_change"]);
  assert.ok(paletteTools.every(tool => tool.annotations?.openWorldHint === false));
} finally {
  await paletteClient.close();
}
process.stdout.write("MCP stdio initialize, full and palette tool discovery OK.\n");
