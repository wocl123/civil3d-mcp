// 편경사 변화 지점 하나. 차로 경사는 % (alignment.section "superelevation").
export type AlignmentSuperelevation = {
  curveName: string;
  station: number;
  stationText: string;
  type: string;
  region: string;
  leftOutLanePercent?: number;    // 왼쪽 바깥 차로
  leftInLanePercent?: number;     // 왼쪽 안쪽 차로
  rightInLanePercent?: number;    // 오른쪽 안쪽 차로
  rightOutLanePercent?: number;   // 오른쪽 바깥 차로
};
