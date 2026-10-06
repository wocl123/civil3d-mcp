// One vertical curve (profile.section "curves"); grades and K as Civil 3D computed them.
export type ProfileCurve = {
  number: number; curveType: string; crestOrSag: "Crest" | "Sag" | string; startStation: number; endStation: number;
  startStationText: string; endStationText: string; length: number; pviStation: number; pviStationText: string; pviElevation: number;
  gradeInPercent?: number; gradeOutPercent?: number; gradeChangePercent?: number; k?: number;
};
