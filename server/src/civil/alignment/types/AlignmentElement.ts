// 선형 요소 하나: 직선, 원곡선, 완화곡선 (alignment.section "elements"). 검토에 쓰는 필드만.
export type AlignmentElement = {
  order: number;                          // 선형 안의 순서
  curveGroup: number;                     // 속한 곡선 번호(직선은 0)
  kind: "Line" | "Arc" | "Spiral" | string;
  startStation: number;
  endStation: number;
  startStationText: string;
  endStationText: string;
  length: number;
  radius?: number;
  deltaDeg?: number;                      // 교각
  tangent?: number;                       // 접선장
  external?: number;                      // 외할
  spiralA?: number;                       // 완화곡선 파라미터 A
  spiralInOut?: string;
};
