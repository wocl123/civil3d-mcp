// A superelevation critical station with lane slopes in percent (alignment.section "superelevation").
export type AlignmentSuperelevation = {
  curveName: string; station: number; stationText: string; type: string; region: string;
  leftOutLanePercent?: number; leftInLanePercent?: number; rightInLanePercent?: number; rightOutLanePercent?: number;
};
