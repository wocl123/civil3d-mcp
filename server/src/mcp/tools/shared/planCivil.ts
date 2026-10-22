import { withDrawing } from "../../../bridge/boundOperation.js";
import { callPlugin } from "../../../bridge/pluginClient.js";
import type { CivilPlan } from "../../../criteria/types/CivilPlan.js";
import type { FixOption } from "../../../criteria/types/FixOption.js";
import { storeFix } from "../../../changes/changeStore.js";

export async function planCivil(operation: string, input: Record<string, unknown>) {
  return withDrawing(async () => {
    const civil = await callPlugin("drawing.civil_preview", { operation, ...input }, 120000) as CivilPlan;
    const fix: FixOption = { title: civil.summary, changes: [], civil, status: "feasible", effects: civil.details };
    await storeFix(fix, civil.summary, operation, { check: "none" });
    return { summary: civil.summary, details: civil.details,
      option: { id: fix.id, applicable: fix.applicable, summary: civil.summary },
      note: "Nothing changed. Show the plan and ask for agreement before applying." };
  });
}
