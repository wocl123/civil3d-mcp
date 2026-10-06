import type { CheckItem } from "../criteria/types/CheckItem.js";
import type { FixOption } from "../criteria/types/FixOption.js";

// What the AI needs of a fix or plan to show it and to agree to it by id. The stored copy
// (changes/changeStore.ts) keeps how to apply it: the objects to change and, for a plan,
// the whole creation request with every polyline vertex, which would only fill the context.
export function fixView(fix: FixOption) {
  return {
    id: fix.id, title: fix.title, applicable: fix.applicable, status: fix.status,
    ...(fix.reason ? { reason: fix.reason } : {}),
    ...(fix.changes.length ? { changes: fix.changes.map(({ property, from, to, unit }) => ({ property, ...(from !== undefined ? { from } : {}), to, unit })) } : {}),
    effects: fix.effects
  };
}

export const itemsView = (items: CheckItem[]) =>
  items.map(item => item.fixes ? { ...item, fixes: item.fixes.map(fixView) } : item);
