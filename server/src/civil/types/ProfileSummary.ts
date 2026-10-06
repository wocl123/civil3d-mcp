// 종단 요약. type: EG(지표면), FG(계획) 등.
export type ProfileSummary = {
  name: string;
  handle: string;
  type: string;
  layer: string;
  startStation: number;
  endStation: number;
  startStationText: string;
  endStationText: string;
  alignmentName?: string;
  alignmentHandle?: string;
};
