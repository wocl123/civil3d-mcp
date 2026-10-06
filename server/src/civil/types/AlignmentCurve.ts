// One horizontal curve group as the plug-in returns it (alignment.section "curves").
export type AlignmentCurve = {
  number: number; groupType: string; startStation: number; endStation: number;
  startStationText: string; endStationText: string; length: number; turn?: string;
  minRadius?: number; totalDeltaDeg?: number; spiralAIn?: number; spiralAOut?: number; elementCount: number;
};
