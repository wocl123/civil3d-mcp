// One line, arc, or spiral (alignment.section "elements"); only the fields the checks use.
export type AlignmentElement = {
  order: number; curveGroup: number; kind: "Line" | "Arc" | "Spiral" | string;
  startStation: number; endStation: number; startStationText: string; endStationText: string; length: number;
  radius?: number; deltaDeg?: number; tangent?: number; external?: number; spiralA?: number; spiralInOut?: string;
};
