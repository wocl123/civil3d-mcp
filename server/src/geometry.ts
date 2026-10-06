// 계획·수정안 계산에 쓰는 기하 함수.
// 제안하는 값은 올림한다(반올림한 뒤에도 기준을 만족하도록).

// 올림/내림/반올림, 도 → 라디안
export const ceilTo = (value: number, step = 1) => Math.ceil(value / step - 1e-9) * step;
export const floorTo = (value: number, step = 1) => Math.floor(value / step + 1e-9) * step;
export const round = (value: number, digits = 3) => Math.round(value * 10 ** digits) / 10 ** digits;
export const radians = (degrees: number) => degrees * Math.PI / 180;

// 측점 문자열 "0+000.00" (수정안 설명에만 쓴다).
export function station(value: number): string {
  const km = Math.floor(value / 1000);
  return `${km}+${(value - km * 1000).toFixed(2).padStart(6, "0")}`;
}

// 교각 deltaDeg(도)인 두 접선 사이 원곡선의 접선장 T, 곡선 길이 L, 외할 E.
export const arcTangent = (radius: number, deltaDeg: number) => radius * Math.tan(radians(deltaDeg) / 2);
export const arcLength = (radius: number, deltaDeg: number) => radius * radians(deltaDeg);
export const arcExternal = (radius: number, deltaDeg: number) => radius * (1 / Math.cos(radians(deltaDeg) / 2) - 1);

// IP의 곡선: 원곡선 + (spiral > 0이면) 양쪽에 길이 spiral인 클로소이드.
export type Curve = { radius: number; spiral: number };

// 클로소이드의 이정량 p(원곡선이 안쪽으로 밀리는 양)와 접선 증가량 k. 표준 급수의 둘째 항까지.
export const spiralShift = (radius: number, spiral: number) =>
  spiral ** 2 / (24 * radius) - spiral ** 4 / (2688 * radius ** 3);
export const spiralK = (radius: number, spiral: number) =>
  spiral / 2 - spiral ** 3 / (240 * radius ** 2);

// IP에서 곡선 시작점까지의 접선장. deltaRad: 교각(라디안).
export function curveTangent({ radius, spiral }: Curve, deltaRad: number): number {
  if (!spiral) return radius * Math.tan(deltaRad / 2);
  return (radius + spiralShift(radius, spiral)) * Math.tan(deltaRad / 2) + spiralK(radius, spiral);
}

// 곡선 전체 길이 = 원곡선 + 완화곡선 둘 = RΔ − Ls + 2Ls.
export const curveLength = ({ radius, spiral }: Curve, deltaRad: number) => radius * deltaRad + spiral;
