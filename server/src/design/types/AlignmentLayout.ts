// 플러그인이 읽은 폴리라인 꼭짓점.
// bulge = tan(호 중심각 / 4), 반시계 방향이 +.
export type PolylineVertex = { x: number; y: number; bulge: number };

// IP(교점). 폴리라인에 호가 있던 IP는 그 호의 반지름(radius)을 가진다.
export type PlanPoint = { x: number; y: number; radius?: number };

// 플러그인이 선형을 만드는 데 필요한 것 (alignment.create).
// curves[i]는 points[i + 1]의 곡선이고, radius가 없으면 그 IP는 곡선 없이 꺾인다.
// 도로는 설계기준에 맞춰 배치하고(Centerline), 그 밖의 용도는 요청한 곳에만 곡선을 넣는다(Utility).
export type AlignmentCreateRequest = {
  name: string;
  type: "Centerline" | "Utility";

  // 계획할 때 읽은 폴리라인. 그 뒤로 바뀌었으면 플러그인이 만들기를 거절한다.
  polyline: { handle: string; vertices: PolylineVertex[] };

  points: { x: number; y: number }[];
  curves: { radius?: number; spiralLength?: number }[];
  designSpeed?: number;

  // 선형 설명(Description)에 쓸 기록. 예: "용도: 도로, 관망 / 기준: 도로구조규칙 / ..."
  description: string;
};

// 계획 도구가 보여 주는 IP 하나.
export type PlannedIp = {
  ip: number;
  x: number;
  y: number;
  deflectionDeg: number;       // 교각
  turn: "좌" | "우";
  straightBefore: number;      // 앞 직선 길이
  straightAfter: number;       // 뒤 직선 길이
  radius?: number;             // 계획 반지름
  radiusFrom?: string;         // 반지름의 근거 (기준 조문, 사용자 지정, 폴리라인 호)
  minRadius?: number;          // 기준이 요구하는 최소 반지름
  maxRadius?: number;          // 앞뒤 곡선 사이에 들어가는 최대 반지름
  spiralLength?: number;
  spiralA?: number;            // 클로소이드 파라미터 A
  tangent: number;             // 접선장
  curveLength?: number;
  status: "ok" | "overlap" | "below_criteria" | "angle_point";
  note?: string;
};
