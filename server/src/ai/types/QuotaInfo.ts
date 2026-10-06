import type { QuotaWindow } from "./QuotaWindow.js";

export type QuotaInfo = {
  status: "available" | "unsupported" | "unavailable";
  windows: QuotaWindow[];
  ordinaryUsageAllowed: boolean | null;
  message: string;
};
