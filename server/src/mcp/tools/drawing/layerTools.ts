// 레이어 생성·상태 변경·삭제 계획을 보여 준 뒤 기존 적용 도구로 실행한다.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { callPlugin } from "../../../bridge/pluginClient.js";
import { withDrawing } from "../../../bridge/boundOperation.js";
import { storeFix } from "../../../changes/changeStore.js";
import type { FixOption } from "../../../criteria/types/FixOption.js";
import type { LayerEdit, LayerObjectTarget, LayerRequest, LayerState } from "../../../criteria/types/LayerRequest.js";
import { toolResult } from "../../toolResult.js";

type PreviewItem = {
  name: string; handle?: string; before?: LayerState; after?: LayerState; changeColor?: boolean;
  objects: LayerObjectTarget[]; effects: string[]; blocked?: string;
};
type Preview = { items: PreviewItem[] };
const name = z.string().min(1).max(255);
const color = z.number().int().min(1).max(255);
const names = z.array(name).min(1).max(100);
const fields = { color: color.optional(), locked: z.boolean().optional(),
  frozen: z.boolean().optional(), off: z.boolean().optional() };

export function registerLayerTools(server: McpServer): void {
  server.registerTool("plan_layer_create", {
    title: "Plan creating drawing layers",
    description: "Plan new layers with exact names, ACI colours (1-255, default 7), locked, frozen and off states " +
      "(default false). Existing layers stay unchanged. Show the planned states and ask before applying the option id.",
    inputSchema: { layers: z.array(z.object({ name, color: color.default(7), locked: z.boolean().default(false),
      frozen: z.boolean().default(false), off: z.boolean().default(false) })).min(1).max(100) },
    annotations: { readOnlyHint: true, openWorldHint: false }
  }, async ({ layers }) => toolResult(await planLayers("create", { create: layers })));

  server.registerTool("plan_layer_edit", {
    title: "Plan drawing layer state changes",
    description: "Plan changing existing layers' colour, locked, frozen or off state without changing the drawing. " +
      "Unspecified properties stay unchanged. Set locked=false to unlock, frozen=false to thaw, off=false to turn on. " +
      "Cannot freeze the current layer or edit xref layers. " +
      "Show before/after states and ask before applying the option id.",
    inputSchema: { names, ...fields },
    annotations: { readOnlyHint: true, openWorldHint: false }
  }, async args => toolResult(await planLayers("edit", args)));

  server.registerTool("plan_layer_delete", {
    title: "Plan deleting drawing layers and optionally their objects",
    description: "First plan with deleteObjects=false (default). Reports objects, types and related effects for occupied " +
      "layers; ask whether to delete those objects too. Only after explicit agreement use deleteObjects=true to make a " +
      "new plan. It includes objects in layouts and block definitions, network pipes/structures on other layers and " +
      "dependent labels. Show the full effects and ask to press 진행 or agree to that new plan before applying its id. " +
      "Layer 0, Defpoints, current and xref layers stay protected. Remaining settings references cancel the entire apply.",
    inputSchema: { names, deleteObjects: z.boolean().default(false) },
    annotations: { readOnlyHint: true, openWorldHint: false }
  }, async args => toolResult(await planLayers("delete", args)));
}

function stateText(state: LayerState): string {
  return "색상 ACI " + state.color + ", " + (state.locked ? "잠금" : "잠금 해제") + ", " +
    (state.frozen ? "동결" : "해동") + ", " + (state.off ? "꺼짐" : "켜짐");
}

function objectView(item: PreviewItem) {
  const types: Record<string, number> = {};
  for (const object of item.objects) {
    types[object.type] = (types[object.type] ?? 0) + 1;
  }

  return { objectCount: item.objects.length, byType: types, effects: item.effects };
}

function detail(item: PreviewItem, action: LayerRequest["action"]): string {
  if (action === "create") {
    return item.name + ": " + stateText(item.after!);
  }

  if (action === "edit") {
    return item.name + ": " + stateText(item.before!) + " → " + stateText(item.after!);
  }

  const { objectCount, byType } = objectView(item);
  const kinds = Object.entries(byType).map(([type, count]) => type + " " + count + "개").join(", ");
  return item.name + ": 객체 " + objectCount + "개 함께 삭제" + (kinds ? " (" + kinds + ")" : "");
}

async function planLayers(action: LayerRequest["action"], input: Record<string, unknown>) {
  return withDrawing(async () => {
    const preview = await callPlugin("drawing.layer_preview", { action, ...input }) as Preview;
    const blocked = preview.items.filter(item => item.blocked).map(item => ({
      name: item.name, reason: item.blocked, ...objectView(item)
    }));
    const ready = preview.items.filter(item => !item.blocked
      && (action !== "edit" || JSON.stringify(item.before) !== JSON.stringify(item.after) || item.changeColor));
    const planned = ready.map(item => ({
      name: item.name, before: item.before, after: item.after, ...objectView(item)
    }));
    const view = { action, layers: planned, blocked };
    if (!ready.length) {
      return { ...view, option: null, note: "No changes yet. Explain blocked reasons or unchanged states. " +
        "If layers contain objects, ask whether to include them, then plan again with deleteObjects=true after agreement." };
    }

    return savePlan(action, input, ready, view);
  });
}

async function savePlan(
  action: LayerRequest["action"], input: Record<string, unknown>, ready: PreviewItem[], view: unknown
) {
  const verb = action === "create" ? "생성" : action === "edit" ? "상태 변경" : "삭제";
  const unique = new Set(ready.flatMap(item => item.objects.map(object => object.handle)));
  if (unique.size > 1000) {
    throw new Error("한 번에 삭제할 객체는 1000개 이하로 나누어 요청하세요.");
  }

  const suffix = action === "delete" && unique.size ? " (객체 " + unique.size + "개 포함)" : "";
  const summary = "레이어 " + ready.length + "개 " + verb + suffix;
  const effects = [...new Set(ready.flatMap(item => item.effects))];
  const details = [...ready.map(item => detail(item, action)), ...effects];
  const edits: LayerEdit[] = action === "edit" ? ready.map(item => ({ name: item.name, handle: item.handle!,
    before: item.before!, after: item.after!, changeColor: item.changeColor === true })) : [];
  const targets = action === "delete"
    ? ready.map(item => ({ name: item.name, handle: item.handle!, objects: item.objects })) : [];
  const layers: LayerRequest = {
    action,
    create: action === "create" ? ready.map(item => ({ name: item.name, ...item.after! })) : [],
    targets,
    edits,
    deleteObjects: input.deleteObjects === true,
    summary,
    details
  };
  const fix: FixOption = { title: summary, changes: [], layers, status: "feasible", effects };
  await storeFix(fix, "레이어 " + ready.length + "개", "레이어 " + verb, { check: "none" });
  return { ...(view as Record<string, unknown>), option: { id: fix.id, applicable: fix.applicable, summary },
    note: "Nothing changed yet. Explain every planned state and deletion effect, including objects on other layers, " +
      "and ask for agreement to this new plan before applying." };
}
