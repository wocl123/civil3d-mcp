// 수정안이 바꾸는 값 하나. 적용 단계(apply_drawing_change)가 그대로 실행할 수 있는 형태다.
// object.kind 는 무엇을 바꾸는지, handle 과 at(측점)은 도면에서 그것을 찾는 위치다.
export type DesignChange = {
  object: {
    kind: "profileCurve" | "profilePvi" | "profileTangent" | "alignmentArc" | "alignmentSpiral" | "alignment";
    handle: string;
    at?: number;
  };
  property: string;   // 바꿀 속성 (예: radius, elevation, length)
  from?: number;      // 계산할 때의 값. 적용 직전에 도면 값이 이것과 같은지 확인한다.
  to: number;         // 바꿀 값
  unit: string;
};
