// 선형 속성 편집 계획 도구 (plan_alignment_edit).
// 이름·설명·스타일·레이어·라벨 세트·설계속도를 선형 여러 개에 한 번에 바꾸는 계획을 만든다. 형상은 바꾸지 않는다.
// 플러그인이 대상마다 바뀌기 전 → 후를 계산하고 확인한다(스타일·레이어가 도면에 있는지, 이름이 겹치지 않는지).
// 계획은 id와 함께 저장되고, 팔레트는 [적용하기] 카드로 보여 준다. 동의하면 apply_drawing_change 로 적용한다(Undo 한 번).
// 도구 설명은 AI가 읽으므로 영어로 둔다.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { callPlugin } from "../../bridge/pluginClient.js";
import { storeFix } from "../../changes/changeStore.js";
import type { AlignmentEdit, FixOption } from "../../criteria/types/FixOption.js";
import type { FixSource } from "../../changes/types/StoredFix.js";
import { toolResult } from "../toolResult.js";

// 플러그인 미리 보기 결과 (AlignmentEditing.cs)
type Change = { property: string; from: string; to: string };
type PreviewItem = { name: string; handle: string; changes: Change[]; blocked?: string };
type Preview = { items: PreviewItem[]; notFound: string[] };

// 카드에 보이는 대상 줄 수. 넘으면 "외 N개"로 줄인다.
const MAX_DETAILS = 40;

export function registerAlignmentEditTools(server: McpServer): void {
  server.registerTool("plan_alignment_edit", {
    title: "Plan alignment property changes",
    description: "Plan changing alignment properties without changing geometry: name (one new name, or prefix/suffix/find-replace " +
      "for many), description, style, layer, label set, and design speeds (stations in metres along the alignment, each speed " +
      "applies from its station; replaces all existing design speeds). Name alignments by name or handle, or set allAlignments. " +
      "Style, layer and label set must already exist in the drawing (the error lists the available names). Changes nothing; " +
      "returns each alignment's before → after, what cannot be changed, and an option with an id. Show it and ask; apply only " +
      "when the user's next message agrees (or the user presses 적용하기), by passing the id to apply_drawing_change.",
    inputSchema: {
      alignments: z.array(z.string().min(1).max(255)).max(500).optional().describe("Alignment names or handles."),
      allAlignments: z.boolean().optional(),
      rename: z.object({
        to: z.string().min(1).max(255).optional().describe("New name; only for a single alignment."),
        prefix: z.string().max(100).optional(),
        suffix: z.string().max(100).optional(),
        find: z.string().min(1).max(100).optional(),
        replace: z.string().max(100).optional()
      }).optional(),
      description: z.string().max(1000).optional(),
      style: z.string().min(1).max(255).optional().describe("Alignment style name."),
      layer: z.string().min(1).max(255).optional().describe("Existing layer name."),
      labelSet: z.string().min(1).max(255).optional().describe("Alignment label set name; replaces the current labels."),
      designSpeeds: z.array(z.object({
        station: z.number().describe("Station in metres (raw, e.g. 500 for 0+500)."),
        speed: z.number().min(10).max(200).describe("km/h")
      })).min(1).max(100).optional()
    },
    annotations: { readOnlyHint: true, openWorldHint: false }
  }, async args => {
    const preview = await callPlugin("alignment.edit_preview", args, 120000) as Preview;
    const changing = preview.items.filter(item => !item.blocked && item.changes.length);
    const blocked = preview.items.filter(item => item.blocked).map(item => `${item.name}: ${item.blocked}`);
    const unchanged = preview.items.filter(item => !item.blocked && !item.changes.length).map(item => item.name);
    const view = {
      change: changing.map(item => ({ name: item.name, changes: item.changes })),
      ...(blocked.length ? { cannotChange: blocked } : {}),
      ...(unchanged.length ? { alreadySame: unchanged } : {}),
      ...(preview.notFound.length ? { notFound: preview.notFound } : {})
    };
    if (!changing.length) return toolResult({ ...view, option: null, note: "Nothing to change. Tell the user why." });

    // 계획 저장: 미리 본 값 그대로 적용한다.
    const value = (item: PreviewItem, property: string) => item.changes.find(change => change.property === property)?.to;
    const edits: AlignmentEdit[] = changing.map(item => ({
      handle: item.handle, name: item.name,
      ...(value(item, "이름") !== undefined ? { newName: value(item, "이름") } : {}),
      ...(value(item, "설명") !== undefined ? { description: value(item, "설명") } : {}),
      ...(value(item, "스타일") !== undefined ? { style: value(item, "스타일") } : {}),
      ...(value(item, "레이어") !== undefined ? { layer: value(item, "레이어") } : {}),
      ...(value(item, "라벨 세트") !== undefined ? { labelSet: value(item, "라벨 세트") } : {}),
      ...(value(item, "설계속도") !== undefined && args.designSpeeds ? { designSpeeds: args.designSpeeds } : {})
    }));
    const properties = [...new Set(changing.flatMap(item => item.changes.map(change => change.property)))];
    const summary = `선형 ${changing.length}개 ${properties.join("·")} 변경`;
    const lines = changing.map(item => `${item.name}: ` + item.changes.map(change => `${change.property} ${change.from} → ${change.to}`).join(", "));
    const details = lines.length > MAX_DETAILS ? [...lines.slice(0, MAX_DETAILS), `외 ${lines.length - MAX_DETAILS}개`] : lines;
    // 설계속도를 바꾸면 기준 검토 결과가 달라진다: 선형 하나면 적용 뒤 다시 검토한다.
    const source: FixSource = args.designSpeeds && changing.length === 1
      ? { check: "alignment", input: { alignment: changing[0].handle } } : { check: "none" };
    const fix: FixOption = { title: summary, changes: [], edit: { edits, summary, details }, status: "feasible", effects: [] };
    await storeFix(fix, `선형 ${changing.length}개`, "속성 변경", source);

    return toolResult({
      ...view,
      option: { id: fix.id, applicable: fix.applicable, summary },
      note: "Nothing was changed yet. The palette shows this plan as a card with 적용하기. Summarize the change briefly and ask." +
        (args.designSpeeds && changing.length > 1 ? " Design speeds change criteria results; offer check_all_alignments after applying." : "")
    });
  });
}
