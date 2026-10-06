// 한도 구간 하나 (예: 5시간, 7일).
export type QuotaWindow = {
  label: string;
  usedPercent: number;
  remainingPercent: number;
  resetsAt: string | null;   // 재설정 시각(ISO), 모르면 null
};
