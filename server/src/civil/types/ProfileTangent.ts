// 종단의 직선 경사 구간 하나 (profile.section "tangents").
export type ProfileTangent = {
  number: number;
  startStation: number;
  endStation: number;
  startStationText: string;
  endStationText: string;
  length: number;
  gradePercent?: number;   // 경사(%)
};
