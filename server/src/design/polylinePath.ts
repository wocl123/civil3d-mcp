import type { PlanPoint, PolylineVertex } from "./types/AlignmentLayout.js";

// A polyline as a chain of points of intersection (IPs). Straight vertices are IPs;
// an arc segment becomes the IP where its end tangents meet, and its radius is kept
// as the radius the drawer meant there. Points on a straight line between two others
// (such as the ends of an arc that runs into straight segments) are dropped.
const SAME_POINT = 1e-6;
const STRAIGHT_DEG = 0.001;

export function polylinePath(vertices: PolylineVertex[], reverse = false): PlanPoint[] {
  const ordered = reverse ? reversed(vertices) : vertices;
  const points: PlanPoint[] = [{ x: ordered[0].x, y: ordered[0].y }];
  for (let index = 0; index < ordered.length - 1; index++) {
    const start = ordered[index];
    const end = ordered[index + 1];
    const bulge = start.bulge;
    if (Math.abs(bulge) > 1e-9) {
      if (Math.abs(bulge) >= 1 - 1e-9)
        throw new Error(`폴리라인 ${index + 1}번째 호가 반원 이상이라 IP로 바꿀 수 없음`);
      const delta = 4 * Math.atan(Math.abs(bulge));
      const chord = Math.hypot(end.x - start.x, end.y - start.y);
      const startDirection = Math.atan2(end.y - start.y, end.x - start.x) - Math.sign(bulge) * delta / 2;
      const tangent = chord / (2 * Math.cos(delta / 2));
      points.push({
        x: start.x + tangent * Math.cos(startDirection), y: start.y + tangent * Math.sin(startDirection),
        radius: chord / (2 * Math.sin(delta / 2))
      });
    }
    points.push({ x: end.x, y: end.y });
  }
  return simplify(points);
}

// Reversing a polyline moves each bulge to the segment's other end and flips its sign.
function reversed(vertices: PolylineVertex[]): PolylineVertex[] {
  const list = [...vertices].reverse();
  return list.map((vertex, index) => ({ x: vertex.x, y: vertex.y, bulge: index < list.length - 1 ? -list[index + 1].bulge : 0 }));
}

function simplify(points: PlanPoint[]): PlanPoint[] {
  const list = points.filter((point, index) => index === 0 ||
    Math.hypot(point.x - points[index - 1].x, point.y - points[index - 1].y) > SAME_POINT);
  for (let index = 1; index < list.length - 1;) {
    if (list[index].radius === undefined && Math.abs(deflection(list[index - 1], list[index], list[index + 1])) < STRAIGHT_DEG)
      list.splice(index, 1);
    else index++;
  }
  return list;
}

// Signed deflection angle at b in degrees, between the directions a→b and b→c. Positive turns left.
export function deflection(a: PlanPoint, b: PlanPoint, c: PlanPoint): number {
  const [ux, uy, vx, vy] = [b.x - a.x, b.y - a.y, c.x - b.x, c.y - b.y];
  return Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy) * 180 / Math.PI;
}

export const distance = (a: PlanPoint, b: PlanPoint) => Math.hypot(b.x - a.x, b.y - a.y);
