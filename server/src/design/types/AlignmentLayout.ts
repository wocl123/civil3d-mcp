// A polyline vertex as the plug-in reads it (bulge = tan(arc angle / 4), positive counter-clockwise).
export type PolylineVertex = { x: number; y: number; bulge: number };

// A point of intersection; radius is set when the polyline had an arc there.
export type PlanPoint = { x: number; y: number; radius?: number };

// What the plug-in needs to create the alignment (alignment.create). curves[i] belongs
// to points[i + 1]; a curve without radius leaves an angle point there. A road is laid
// out to the design criteria (type Centerline); other uses get curves only where asked (type Utility).
export type AlignmentCreateRequest = {
  name: string;
  type: "Centerline" | "Utility";
  // The polyline as read when the layout was planned; the plug-in refuses if it has changed since.
  polyline: { handle: string; vertices: PolylineVertex[] };
  points: { x: number; y: number }[];
  curves: { radius?: number; spiralLength?: number }[];
  designSpeed?: number;
  // "용도: 도로, 관망", written to the alignment's Description.
  description: string;
};

// One IP of a planned layout as the plan tool reports it.
export type PlannedIp = {
  ip: number; x: number; y: number;
  deflectionDeg: number; turn: "좌" | "우";
  straightBefore: number; straightAfter: number;
  radius?: number; radiusFrom?: string;
  minRadius?: number; maxRadius?: number;
  spiralLength?: number; spiralA?: number;
  tangent: number; curveLength?: number;
  status: "ok" | "overlap" | "below_criteria" | "angle_point";
  note?: string;
};
