// 설계속도 항목 하나. 그 측점부터 다음 항목까지 적용된다 (alignment.section "design_speeds").
export type AlignmentDesignSpeed = {
  station: number;
  stationText: string;
  speed: number;   // km/h
};
