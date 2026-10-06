// 폴리라인을 IP(교점) 사슬로 바꾼다.
//   - 직선 꼭짓점은 그대로 IP가 된다.
//   - 호 구간은 양 끝 접선이 만나는 점이 IP가 되고, 그 호의 반지름을 "그린 사람이 의도한 반지름"으로 남긴다.
//   - 두 점 사이 직선 위에 놓인 점(호가 직선으로 이어지는 끝점 등)은 뺀다.

import type { PlanPoint, PolylineVertex } from "./types/AlignmentLayout.js";

const SAME_POINT = 1e-6;     // 이보다 가까우면 같은 점
const STRAIGHT_DEG = 0.001;  // 교각이 이보다 작으면 직선 위의 점

export function polylinePath(vertices: PolylineVertex[], reverse = false): PlanPoint[] {
  const ordered = reverse ? reversed(vertices) : vertices;
  const points: PlanPoint[] = [{ x: ordered[0].x, y: ordered[0].y }];

  for (let index = 0; index < ordered.length - 1; index++) {
    const start = ordered[index];
    const end = ordered[index + 1];
    const bulge = start.bulge;

    // 호 구간: bulge = tan(중심각/4). 반원 이상은 접선이 만나지 않아 IP로 바꿀 수 없다.
    if (Math.abs(bulge) > 1e-9) {
      if (Math.abs(bulge) >= 1 - 1e-9)
        throw new Error(`폴리라인 ${index + 1}번째 호가 반원 이상이라 IP로 바꿀 수 없음`);

      const delta = 4 * Math.atan(Math.abs(bulge));              // 중심각
      const chord = Math.hypot(end.x - start.x, end.y - start.y);
      const startDirection = Math.atan2(end.y - start.y, end.x - start.x) - Math.sign(bulge) * delta / 2;
      const tangent = chord / (2 * Math.cos(delta / 2));         // 시점에서 IP까지

      points.push({
        x: start.x + tangent * Math.cos(startDirection),
        y: start.y + tangent * Math.sin(startDirection),
        radius: chord / (2 * Math.sin(delta / 2))
      });
    }
    points.push({ x: end.x, y: end.y });
  }
  return simplify(points);
}

// 폴리라인을 뒤집으면 각 bulge는 구간의 다른 끝으로 옮겨 가고 부호가 바뀐다.
function reversed(vertices: PolylineVertex[]): PolylineVertex[] {
  const list = [...vertices].reverse();
  return list.map((vertex, index) => ({
    x: vertex.x,
    y: vertex.y,
    bulge: index < list.length - 1 ? -list[index + 1].bulge : 0
  }));
}

// 겹친 점과, 직선 위에 놓인 점(반지름이 없는)을 뺀다.
function simplify(points: PlanPoint[]): PlanPoint[] {
  const list = points.filter((point, index) =>
    index === 0 || Math.hypot(point.x - points[index - 1].x, point.y - points[index - 1].y) > SAME_POINT);

  for (let index = 1; index < list.length - 1;) {
    const straight = Math.abs(deflection(list[index - 1], list[index], list[index + 1])) < STRAIGHT_DEG;
    if (list[index].radius === undefined && straight) list.splice(index, 1);
    else index++;
  }
  return list;
}

// b에서의 교각(도, 부호 있음): a→b 방향과 b→c 방향 사이. 좌회전이 +.
export function deflection(a: PlanPoint, b: PlanPoint, c: PlanPoint): number {
  const [ux, uy, vx, vy] = [b.x - a.x, b.y - a.y, c.x - b.x, c.y - b.y];
  return Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy) * 180 / Math.PI;
}

export const distance = (a: PlanPoint, b: PlanPoint) => Math.hypot(b.x - a.x, b.y - a.y);
