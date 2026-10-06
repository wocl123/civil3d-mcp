// Geometry helpers for plans and fixes. Proposed values are rounded up so they
// still meet the limit after rounding.
export const ceilTo = (value: number, step = 1) => Math.ceil(value / step - 1e-9) * step;
export const floorTo = (value: number, step = 1) => Math.floor(value / step + 1e-9) * step;
export const round = (value: number, digits = 3) => Math.round(value * 10 ** digits) / 10 ** digits;
export const radians = (degrees: number) => degrees * Math.PI / 180;

// A station in the common 0+000.00 form, for fix descriptions only.
export function station(value: number): string {
  const km = Math.floor(value / 1000);
  return `${km}+${(value - km * 1000).toFixed(2).padStart(6, "0")}`;
}

// Circular arc between two tangents with deflection delta (degrees).
export const arcTangent = (radius: number, deltaDeg: number) => radius * Math.tan(radians(deltaDeg) / 2);
export const arcLength = (radius: number, deltaDeg: number) => radius * radians(deltaDeg);
export const arcExternal = (radius: number, deltaDeg: number) => radius * (1 / Math.cos(radians(deltaDeg) / 2) - 1);

// A curve at an IP: a circular arc, with clothoids of length spiral on both sides when spiral > 0.
export type Curve = { radius: number; spiral: number };

// Clothoid shift p (the arc moves inward) and tangent growth k, by the standard series to the second term.
export const spiralShift = (radius: number, spiral: number) => spiral ** 2 / (24 * radius) - spiral ** 4 / (2688 * radius ** 3);
export const spiralK = (radius: number, spiral: number) => spiral / 2 - spiral ** 3 / (240 * radius ** 2);

// Tangent length from the IP to the start of the curve, for a deflection deltaRad (radians).
export function curveTangent({ radius, spiral }: Curve, deltaRad: number): number {
  if (!spiral) return radius * Math.tan(deltaRad / 2);
  return (radius + spiralShift(radius, spiral)) * Math.tan(deltaRad / 2) + spiralK(radius, spiral);
}

// Arc plus both spirals: RΔ − Ls + 2Ls.
export const curveLength = ({ radius, spiral }: Curve, deltaRad: number) => radius * deltaRad + spiral;
