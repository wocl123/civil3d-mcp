// 종단곡선 하나 (profile.section "curves"). 경사와 K는 Civil 3D가 계산한 값.
export type ProfileCurve = {
  number: number;
  curveType: string;                     // Circular, ParabolaSymmetric, ParabolaAsymmetric
  crestOrSag: "Crest" | "Sag" | string;  // 볼록 / 오목
  startStation: number;
  endStation: number;
  startStationText: string;
  endStationText: string;
  length: number;
  pviStation: number;                    // VIP 측점
  pviStationText: string;
  pviElevation: number;
  gradeInPercent?: number;               // 들어가는 경사(%)
  gradeOutPercent?: number;              // 나가는 경사(%)
  gradeChangePercent?: number;           // 경사 차(%)
  k?: number;                            // 종단곡선 변화 비율 K
};
