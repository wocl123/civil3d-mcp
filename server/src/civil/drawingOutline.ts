import { callPlugin } from "../bridge/pluginClient.js";
import { alignmentProfiles } from "./civilData.js";
import { readUses } from "./alignmentRecord.js";

const MAX_ALIGNMENTS = 15;

// A short list of the drawing's alignments and their profiles for the prompt, so the
// AI can call a tool by name at once instead of listing first. The plug-in keeps
// alignments cached per drawing revision, so this costs little. Errors leave it out.
export async function drawingOutline(): Promise<string> {
  try {
    const page = await callPlugin("alignment.list", { offset: 0, limit: MAX_ALIGNMENTS }) as {
      totalCount: number;
      items: { name: string; handle: string; type: string; startStationText: string; endStationText: string; profileCount: number; description?: string | null }[];
    };
    if (!page.items.length) return "";
    const lines = await Promise.all(page.items.map(async alignment => {
      const profiles = alignment.profileCount ? await alignmentProfiles(alignment.handle) : [];
      const list = profiles.map(profile => `${profile.name}(${profile.type})`).join(", ");
      const uses = readUses(alignment.description);
      return `- 선형 ${alignment.name} [${alignment.handle}, ${alignment.type}, ${alignment.startStationText}~${alignment.endStationText}${uses ? `, 용도 ${uses.join("·")}` : ""}]` +
        (list ? `: 종단 ${list}` : "");
    }));
    const more = page.totalCount > page.items.length ? [`- 그 밖에 선형 ${page.totalCount - page.items.length}개`] : [];
    return ["Civil objects in the drawing (use these names in tools directly):", ...lines, ...more].join("\n");
  } catch { return ""; }
}
