// 종단의 PVI(종단 교점) 하나 (profile.section "pvis").
export type ProfilePvi = {
  number: number;
  station: number;
  stationText: string;
  elevation: number;
  gradeInPercent?: number;
  gradeOutPercent?: number;
  curveType: string;   // 이 PVI의 종단곡선 종류(없으면 None)
};
