// Fake polylines and alignment.create for the bridge. A created alignment is modelled
// well enough (curves, elements, design speed) for the criteria recheck to read it.
const b15 = Math.tan(Math.PI / 12);
const polylines = {
  "2A1": { layer: 'C-ROAD-PLAN', closed: false, vertices: [[1000, 2000, 0], [1400, 2300, 0], [1900, 2250, 0], [2300, 2600, 0]] },
  "2A2": { layer: 'C-ROAD-PLAN', closed: false, vertices: [[0, 0, 0], [300, 0, b15], [300 + 200 * Math.sin(Math.PI / 3), 100, 0], [300 + 200 * Math.sin(Math.PI / 3) + 150, 100 + 150 * Math.sqrt(3), 0]] },
  "2A3": { layer: '0', closed: true, vertices: [[0, 0, 0], [10, 0, 0], [10, 10, 0]] },
  "2A4": { layer: 'SD-PIPE', closed: false, vertices: [[500, 500, 0], [560, 500, 0], [560, 540, 0], [640, 600, 0]] },
  "2A5": { layer: 'C-ROAD-PLAN', closed: false, vertices: [[0, 0, 0], [150, 0, 0], [250, 80, 0], [400, 60, 0]] }
};
const created = new Map();
const len = v => v.slice(1).reduce((s, p, i) => s + Math.hypot(p[0] - v[i][0], p[1] - v[i][1]), 0);
const t = s => `${Math.floor(s / 1000)}+${(s % 1000).toFixed(2).padStart(6, '0')}`;

function build(req) {
  const P = req.points, elements = [], curves = [];
  let station = 0, order = 1, prevT = 0;
  const seg = i => Math.hypot(P[i + 1].x - P[i].x, P[i + 1].y - P[i].y);
  for (let i = 0; i < P.length - 1; i++) {
    const c = req.curves[i];
    let T = 0, delta = 0;
    if (c?.radius) {
      const a = P[i], b = P[i + 1], d = P[i + 2];
      delta = Math.abs(Math.atan2((b.x - a.x) * (d.y - b.y) - (b.y - a.y) * (d.x - b.x), (b.x - a.x) * (d.x - b.x) + (b.y - a.y) * (d.y - b.y)));
      const R = c.radius, L = c.spiralLength ?? 0;
      const p = L ? L * L / (24 * R) - L ** 4 / (2688 * R ** 3) : 0, k = L ? L / 2 - L ** 3 / (240 * R * R) : 0;
      T = (R + p) * Math.tan(delta / 2) + k;
    }
    const line = seg(i) - prevT - T;
    elements.push({ order: order++, curveGroup: 0, kind: 'Line', groupType: 'Line', startStation: station, endStation: station + line, startStationText: t(station), endStationText: t(station + line), length: line });
    station += line;
    if (c?.radius) {
      const R = c.radius, L = c.spiralLength ?? 0, n = curves.length + 1, arc = R * delta - L, start = station;
      const add = (kind, l, extra) => { elements.push({ order: order++, curveGroup: n, kind, groupType: L ? 'SpiralCurveSpiral' : 'Arc', startStation: station, endStation: station + l, startStationText: t(station), endStationText: t(station + l), length: l, ...extra }); station += l; };
      if (L) add('Spiral', L, { spiralA: Math.sqrt(R * L) });
      add('Arc', arc, { radius: R, deltaDeg: arc / R * 180 / Math.PI });
      if (L) add('Spiral', L, { spiralA: Math.sqrt(R * L) });
      curves.push({ number: n, groupType: L ? 'SpiralCurveSpiral' : 'Arc', startStation: start, endStation: station, startStationText: t(start), endStationText: t(station), length: station - start, minRadius: R, totalDeltaDeg: delta * 180 / Math.PI });
    }
    prevT = T;
  }
  return { elements, curves, length: station };
}

export function handlePolyline(r) {
  const p = r.params ?? {};
  if (r.method === 'drawing.polylines') {
    const items = Object.entries(polylines).filter(([, v]) => !p.layer || v.layer === p.layer).map(([h, v]) => ({
      handle: h, layer: v.layer, vertexCount: v.vertices.length, arcSegmentCount: v.vertices.filter(x => x[2]).length, closed: v.closed,
      length: Math.round(len(v.vertices) * 1000) / 1000, start: v.vertices[0].slice(0, 2), end: v.vertices.at(-1).slice(0, 2) }));
    return { drawingName: 'FAKE-SITE.dwg', offset: 0, limit: p.limit ?? 20, totalCount: items.length, items };
  }
  if (r.method === 'drawing.object' && polylines[p.handle]) {
    const v = polylines[p.handle];
    return { handle: p.handle, type: 'Polyline', dxfName: 'LWPOLYLINE', layer: v.layer, geometry: { elevation: 0, vertexCount: v.vertices.length, closed: v.closed,
      vertices: v.vertices.map(([x, y, bulge]) => ({ x, y, bulge })), verticesTruncated: false } };
  }
  if (r.method === 'alignment.create') {
    if (created.has(p.name) || p.name === '본선') throw new Error(`선형 ${p.name}이(가) 이미 있어 만들지 않았습니다.`);
    const v = polylines[p.polyline.handle];
    if (!v || JSON.stringify(v.vertices.map(([x, y, bulge]) => ({ x, y, bulge }))) !== JSON.stringify(p.polyline.vertices))
      throw new Error(`폴리라인 ${p.polyline.handle}이(가) 계획 뒤에 바뀌어 만들지 않았습니다. 다시 계획하세요.`);
    const model = build(p);
    created.set(p.name, { req: p, ...model, handle: 'D' + created.size });
    return { name: p.name, handle: 'D' + (created.size - 1), type: p.type, length: Math.round(model.length * 1000) / 1000,
      curves: p.curves.map((c, i) => c.radius ? { ip: i + 1, radius: c.radius, spiralLength: c.spiralLength ?? null } : null).filter(Boolean), revision: 'sess1-' + (50 + created.size) };
  }
  if (r.method === 'alignment.list') {
    const extra = [...created.entries()].map(([name, a]) => ({ name, handle: a.handle, type: a.req.type, layer: 'C-ROAD-CL', startStation: 0, endStation: a.length, length: a.length, startStationText: t(0), endStationText: t(a.length), profileCount: 0, description: a.req.description }));
    return extra.length ? { drawingName: 'FAKE-SITE.dwg', offset: 0, limit: 200, totalCount: 2 + extra.length, items: [{ name: '본선' }, { name: 'A램프' }, ...extra] } : undefined;
  }
  const a = created.get(p.alignment) ?? [...created.values()].find(x => x.handle === p.alignment);
  if (!a) return undefined;
  const name = [...created.entries()].find(([, x]) => x === a)[0];
  const summary = { name, handle: a.handle, type: a.req.type, description: a.req.description, layer: 'C-ROAD-CL', startStation: 0, endStation: a.length, length: a.length, startStationText: t(0), endStationText: t(a.length), profileCount: 0 };
  if (r.method === 'alignment.get') return { alignment: summary, settings: { superelevationType: 'Superelevation' } };
  if (r.method === 'alignment.section') {
    const sections = { curves: a.curves, elements: a.elements, design_speeds: a.req.designSpeed ? [{ station: 0, stationText: t(0), speed: a.req.designSpeed }] : [], superelevation: [] };
    const items = sections[p.section] ?? [];
    return { alignmentName: name, alignmentHandle: a.handle, section: p.section, offset: 0, limit: 200, totalCount: items.length, items };
  }
}
