// Small geometry helpers for fixes. Proposed values are rounded up so the fix
// still meets the limit after rounding.
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
