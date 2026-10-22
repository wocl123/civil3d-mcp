import { callPlugin, type BridgeMethod } from "../bridge/pluginClient.js";
import { withDrawing } from "../bridge/boundOperation.js";
import { fixesFor } from "../changes/changeStore.js";
import { currentDrawingScope } from "../memory/drawingScope.js";
import { inPaletteContext } from "../mcp/paletteContext.js";
import { planCivil } from "../mcp/tools/shared/planCivil.js";
import { logTool } from "../logs/workLog.js";

type Route = { tool: string; operation?: string; method?: BridgeMethod; title: string; columns?: string[] };

// 정확히 일치하는 단순 요청만 처리한다. 조건·제외·복합 요청은 AI가 해석한다.
export function quickDrawingRoute(question: string): Route | undefined {
  const text = question.trim().replace(/[.!。]+$/u, "").replace(/\s+/gu, "");
  const deletion = /^(치수선|일반점|일반문자)(?:을|를)?(?:다|모두|전체)(?:삭제|삭제해|삭제해줘|삭제해주세요|지워줘|지워주세요)$/u.exec(text);
  if (deletion) {
    const kind = deletion[1] === "치수선" ? "dimension" : deletion[1] === "일반점" ? "point" : "text";
    return { tool: `plan_${kind}_delete`, operation: `${kind}.delete`, title: deletion[1] };
  }

  const listing = /^(치수선|지표면|관망|네트워크|COGO점)(?:목록|목록보여줘|목록보여주세요|목록조회)$/iu.exec(text);
  if (!listing) {
    return undefined;
  }

  const kind = listing[1].toUpperCase();
  if (kind === "치수선") {
    return { tool: "list_dimensions", method: "dimension.list", title: "치수선",
      columns: ["핸들", "종류", "값", "문자"] };
  }

  if (kind === "지표면") {
    return { tool: "list_surfaces", method: "surface.list", title: "지표면", columns: ["이름", "종류", "핸들", "레이어"] };
  }

  if (kind === "COGO점") {
    return { tool: "list_cogo_points", method: "cogo.list", title: "COGO 점", columns: ["번호", "X", "Y", "Z", "설명"] };
  }

  return { tool: "list_pipe_networks", method: "network.list", title: "중력식 관망", columns: ["이름", "관", "구조물", "핸들"] };
}

function cell(value: unknown): string {
  return String(value ?? "").replace(/\|/gu, "\\|").replace(/[\r\n]/gu, " ").slice(0, 120);
}

function rows(method: BridgeMethod, item: Record<string, any>): unknown[] {
  if (method === "dimension.list") {
    return [item.handle, item.kind, item.measurement, item.text];
  }

  if (method === "surface.list") {
    return [item.name, item.type, item.handle, item.layer];
  }

  if (method === "cogo.list") {
    return [item.number, item.position?.x, item.position?.y, item.position?.z, item.rawDescription];
  }

  return [item.name, item.pipes, item.structures, item.handle];
}

export async function quickDrawing(question: string, requestId: string, signal?: AbortSignal, progress?: () => void) {
  const route = quickDrawingRoute(question);
  if (!route) {
    return undefined;
  }

  signal?.throwIfAborted();
  progress?.();
  const scope = await currentDrawingScope();
  if (!scope.drawingId) {
    throw new Error("도면 식별 정보를 읽을 수 없습니다. Civil 3D 연결을 확인하세요.");
  }

  const started = Date.now();
  let answer = "";
  const context = { requestId, drawingId: scope.drawingId, offeredFixes: [], signal };
  try {
    await inPaletteContext(context, async () => {
      if (route.operation) {
        const plan = await planCivil(route.operation, { all: true });
        answer = `${plan.summary} 계획입니다.\n\n` + plan.details.map(detail => `- ${detail}`).join("\n") +
          "\n\n진행을 누르거나 ‘진행’이라고 답하면 적용합니다.";
        return;
      }

      const data = await withDrawing(() => callPlugin(route.method!, { offset: 0, limit: 50 })) as {
        items?: Record<string, unknown>[]; total?: number; totalCount?: number; note?: string
      };
      if (!Array.isArray(data.items)) {
        throw new Error("목록 응답을 읽을 수 없습니다. 도면 연결 상태를 확인하세요.");
      }

      const count = data.total ?? data.totalCount ?? data.items.length;
      answer = `${route.title} ${count}개입니다.`;
      if (data.items.length) {
        const columns = route.columns!;
        answer += "\n\n| " + columns.join(" | ") + " |\n| " + columns.map(() => "---").join(" | ") + " |\n" +
          data.items.map(item => "| " + rows(route.method!, item).map(cell).join(" | ") + " |").join("\n");
      }

      if (count > data.items.length) {
        answer += `\n\n앞 ${data.items.length}개를 표시했습니다. 이어서 보려면 ‘다음 목록’을 요청하세요.`;
      }

      if (data.note) {
        answer += "\n\n" + data.note;
      }
    });
    await logTool({ requestId, tool: route.tool, ms: Date.now() - started, ok: true, fastPath: true });
  } catch (error) {
    await logTool({ requestId, tool: route.tool, ms: Date.now() - started, ok: false, fastPath: true });
    throw error;
  }

  return { answer, fixes: await fixesFor(requestId), scope, tool: route.tool };
}
