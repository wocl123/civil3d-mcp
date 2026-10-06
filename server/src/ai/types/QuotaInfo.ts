import type { QuotaWindow } from "./QuotaWindow.js";

// 계정의 남은 사용 한도(팔레트 아래 줄에 표시).
export type QuotaInfo = {
  status: "available" | "unsupported" | "unavailable";
  windows: QuotaWindow[];
  ordinaryUsageAllowed: boolean | null;   // 지금 일반 사용이 허용되는지(모르면 null)
  message: string;
};
