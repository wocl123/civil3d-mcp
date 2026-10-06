// 공통 규칙 읽기 도구 (read_knowledge_rule).
// 도구 설명은 AI가 읽으므로 영어로 둔다.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { listRules, readRule } from "../../knowledge/rulesStore.js";
import { toolResult } from "../toolResult.js";

export function registerKnowledgeTools(server: McpServer): void {
  server.registerTool("read_knowledge_rule", {
    title: "Read a common rule",
    description: "Read one common rule file by name, such as how to read the drawing or Korean terms for object types. " +
      "Without a name, list the rule files with their descriptions.",
    inputSchema: { name: z.string().min(1).max(100).optional() },
    annotations: { readOnlyHint: true, openWorldHint: false }
  }, async ({ name }) => {
    // 이름이 없으면 규칙 파일 목록
    if (!name) return toolResult((await listRules()).map(rule => ({ name: rule.name, description: rule.description })));

    const rule = await readRule(name);
    if (!rule) throw new Error(`Rule file "${name}" was not found. Call without a name to list the rule files.`);
    return { content: [{ type: "text" as const, text: rule.body }] };
  });
}
