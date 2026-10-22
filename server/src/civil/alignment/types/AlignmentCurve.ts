// 평면 곡선 그룹 하나 (alignment.section "curves").
export type AlignmentCurve = {
  number: number;           // 곡선 번호(1부터)
  groupType: string;        // Arc, SpiralCurveSpiral 등
  startStation: number;
  endStation: number;
  startStationText: string;
  endStationText: string;
  length: number;
  turn?: string;
  minRadius?: number;       // 그룹 안 원곡선의 최소 반지름
  totalDeltaDeg?: number;   // 그룹 전체 교각
  spiralAIn?: number;       // 들어가는 완화곡선 파라미터 A
  spiralAOut?: number;      // 나가는 완화곡선 파라미터 A
  elementCount: number;
};
