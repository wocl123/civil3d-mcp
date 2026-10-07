// 삭제 계획 도구 (plan_delete).
// 지울 선형·종단·코리더와 연관된 객체를 미리 보고, 계획을 id와 함께 저장한다. 도면은 바꾸지 않는다.
// 선형·종단을 코리더가 쓰면 그 코리더도 함께 지우는 계획이 된다(코리더가 남으면 선형을 지울 수 없다).
// 팔레트는 계획을 연관 객체 목록과 [진행]/[취소] 버튼이 있는 카드로 보여 준다.
// 사용자가 [진행]을 누르거나 다음 메시지에서 동의하면 지운다(Undo 한 번으로 되돌림).
// 도구 설명은 AI가 읽으므로 영어로 둔다.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { callPlugin } from "../../bridge/pluginClient.js";
import { storeFix } from "../../changes/changeStore.js";
import type { FixOption, RemoveTarget } from "../../criteria/types/FixOption.js";
import { toolResult } from "../toolResult.js";

// 플러그인 미리 보기 결과 (DrawingDeletion.cs)
type CorridorLink = { name: string; handle: string; alignments: string[]; surfaces: string[] };
type PreviewItem = {
  kind: "alignment" | "profile" | "corridor"; name: string; handle: string; alignment?: string;
  profiles: string[]; profileViews: number; sampleLineGroups: string[]; offsetAlignments: string[]; corridors: CorridorLink[];
};
type Preview = { items: PreviewItem[]; notFound: string[] };

// 카드에 보이는 연관 객체 줄 수. 넘으면 "외 N개"로 줄인다.
const MAX_DETAILS = 40;

const list = (names: string[], max = 5) => names.length > max ? `${names.slice(0, max).join(", ")} 외 ${names.length - max}개` : names.join(", ");

// 대상 하나의 연관 객체 한 줄. 예: "선형 연결관1선형 — 함께 삭제: 코리더 연결관1, 종단 1개, 종단 뷰 1개"
function detail(item: PreviewItem, deletedAlignments: Set<string>): string {
  const own = item.kind === "corridor" ? [] : item.corridors.map(corridor => `코리더 ${corridor.name}`);
  const together = [
    ...own,
    ...(item.profiles.length ? [`종단 ${item.profiles.length}개(${list(item.profiles, 3)})`] : []),
    ...(item.profileViews ? [`종단 뷰 ${item.profileViews}개`] : [])
  ];
  const affected = [
    ...item.corridors.flatMap(corridor => corridor.surfaces.length ? [`코리더 서피스 ${list(corridor.surfaces, 3)}도 사라짐`] : []),
    ...item.corridors.flatMap(corridor => {
      const kept = corridor.alignments.filter(name => !deletedAlignments.has(name));
      return kept.length ? [`코리더 ${corridor.name}가 쓰는 선형 ${list(kept, 3)}은(는) 남음`] : [];
    }),
    ...(item.sampleLineGroups.length ? [`샘플 라인 그룹 ${list(item.sampleLineGroups, 3)} 영향`] : []),
    ...(item.offsetAlignments.length ? [`오프셋 선형 ${list(item.offsetAlignments, 3)}은(는) 기준을 잃음`] : [])
  ];
  const name = item.kind === "alignment" ? `선형 ${item.name}` : item.kind === "profile" ? `종단 ${item.name} (선형 ${item.alignment})` : `코리더 ${item.name}`;
  return name + (together.length ? ` — 함께 삭제: ${together.join(", ")}` : "") + (affected.length ? ` · ${affected.join(" · ")}` : "");
}

export function registerDeleteTools(server: McpServer): void {
  server.registerTool("plan_delete", {
    title: "Plan deleting alignments, profiles or corridors",
    description: "Plan deleting alignments, profiles and/or corridors, in code, without changing the drawing. Name them by name or handle, " +
      "or set allAlignments to delete every alignment. Deleting an alignment also deletes its profiles and profile views; " +
      "a corridor that uses an alignment or profile as a baseline is deleted with it (the alignment cannot go while the corridor stays). " +
      "Deleting only a corridor keeps its alignments. Returns each target with its related objects (deleted with it, or affected), " +
      "what was not found, and an option with an id. The palette shows the plan as a card with 진행/취소 buttons. " +
      "Tell the user briefly what is related (especially corridors deleted with it) and ask; apply only when the user presses 진행 " +
      "or the user's next message clearly agrees (then pass the id to apply_drawing_change). All deletions are one undo step.",
    inputSchema: {
      alignments: z.array(z.string().min(1).max(255)).max(500).optional().describe("Alignment names or handles."),
      allAlignments: z.boolean().optional().describe("Delete every alignment in the drawing."),
      profiles: z.array(z.object({
        profile: z.string().min(1).max(255).describe("Profile name or handle."),
        alignment: z.string().min(1).max(255).optional().describe("Its alignment, when several profiles share the name.")
      })).max(500).optional(),
      corridors: z.array(z.string().min(1).max(255)).max(500).optional().describe("Corridor names or handles (their alignments stay).")
    },
    annotations: { readOnlyHint: true, openWorldHint: false }
  }, async args => {
    const preview = await callPlugin("drawing.delete_preview", args, 120000) as Preview;
    const items = preview.items;
    const deletedAlignments = new Set(items.filter(item => item.kind === "alignment").map(item => item.name));

    // AI에게 보이는 목록: 대상마다 함께 지워지는 것과 영향받는 것
    const view = {
      delete: items.map(item => ({
        kind: item.kind, name: item.name,
        ...(item.alignment ? { alignment: item.alignment } : {}),
        ...(item.profiles.length ? { profiles: item.profiles.length } : {}),
        ...(item.profileViews ? { profileViews: item.profileViews } : {}),
        ...(item.corridors.length ? { corridors: item.corridors.map(corridor => ({ name: corridor.name,
          ...(corridor.surfaces.length ? { surfaces: corridor.surfaces } : {}),
          ...(corridor.alignments.some(name => !deletedAlignments.has(name)) && item.kind !== "corridor"
            ? { alsoUses: corridor.alignments.filter(name => !deletedAlignments.has(name)) } : {}) })) } : {}),
        ...(item.sampleLineGroups.length ? { sampleLineGroups: item.sampleLineGroups } : {}),
        ...(item.offsetAlignments.length ? { offsetAlignments: item.offsetAlignments } : {})
      })),
      ...(preview.notFound.length ? { notFound: preview.notFound } : {})
    };
    if (!items.length) return toolResult({ ...view, option: null, note: "Nothing can be deleted. Tell the user why." });

    // 지울 목록: 대상 + 함께 지울 코리더(중복 없이)
    const targets = new Map<string, RemoveTarget>();
    for (const item of items) {
      targets.set(item.handle, { kind: item.kind, handle: item.handle, name: item.name });
      for (const corridor of item.corridors) targets.set(corridor.handle, { kind: "corridor", handle: corridor.handle, name: corridor.name });
    }
    const count = (kind: RemoveTarget["kind"]) => [...targets.values()].filter(target => target.kind === kind).length;
    const what = [["선형", count("alignment")], ["종단", count("profile")], ["코리더", count("corridor")]]
      .filter(([, n]) => n).map(([label, n]) => `${label} ${n}개`).join(", ");
    const withProfiles = items.reduce((sum, item) => sum + item.profiles.length, 0);
    const views = items.reduce((sum, item) => sum + item.profileViews, 0);
    const along = [withProfiles ? `종단 ${withProfiles}개` : "", views ? `종단 뷰 ${views}개` : ""].filter(Boolean).join(", ");
    const summary = `${what} 삭제${along ? ` (${along}도 함께)` : ""}`;

    const lines = items.map(item => detail(item, deletedAlignments));
    const details = lines.length > MAX_DETAILS ? [...lines.slice(0, MAX_DETAILS), `외 ${lines.length - MAX_DETAILS}개`] : lines;
    const effects = [...new Set(items.flatMap(item => item.corridors.length || item.sampleLineGroups.length || item.offsetAlignments.length
      ? [detail(item, deletedAlignments)] : []))].slice(0, MAX_DETAILS);
    const fix: FixOption = { title: summary, changes: [], remove: { targets: [...targets.values()], summary, details }, status: "feasible", effects };
    await storeFix(fix, what, "삭제", { check: "none" });

    return toolResult({
      ...view,
      option: { id: fix.id, applicable: fix.applicable, summary },
      note: "Nothing was deleted yet. The palette shows this plan as a card listing every related object, with 진행/취소 buttons. " +
        "In your answer, say briefly what is related (corridors and other objects deleted with it, what stays) and ask the user to " +
        "press 진행 or reply to confirm. Do not repeat the full per-object list."
    });
  });
}
