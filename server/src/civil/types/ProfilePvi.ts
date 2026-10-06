// A PVI of a profile (profile.section "pvis").
export type ProfilePvi = {
  number: number; station: number; stationText: string; elevation: number;
  gradeInPercent?: number; gradeOutPercent?: number; curveType: string;
};
