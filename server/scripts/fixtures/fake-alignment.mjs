const summary = { name: '본선', handle: 'B1', type: 'Centerline', layer: 'C-ROAD-CL', startStation: 0, endStation: 1250.5, length: 1250.5, startStationText: '0+000.00', endStationText: '1+250.50', profileCount: 2, isOffset: false };
const el = (o, g, kind, gt, s, e, extra) => ({ order: o, curveGroup: g, kind, groupType: gt, startStation: s, endStation: e, startStationText: t(s), endStationText: t(e), length: e - s, startPoint: [1000 + s, 2000], endPoint: [1000 + e, 2000], ...extra });
const t = s => `${Math.floor(s / 1000)}+${(s % 1000).toFixed(2).padStart(6, '0')}`;
const elements = [
  el(1, 0, 'Line', 'Line', 0, 300, { azimuthDeg: 45 }),
  el(2, 1, 'Spiral', 'SpiralCurveSpiral', 300, 360, { spiralA: 189.7, radiusOut: 600, turn: 'right', deltaDeg: 2.8648, spiralDefinition: 'Clothoid', spiralInOut: 'in', spiralK: 29.99, spiralP: 0.25 }),
  el(3, 1, 'Arc', 'SpiralCurveSpiral', 360, 610, { radius: 600, turn: 'right', deltaDeg: 23.8732, tangent: 126.86, external: 13.26, chord: 248.2, piStationText: '0+486.90' }),
  el(4, 1, 'Spiral', 'SpiralCurveSpiral', 610, 670, { spiralA: 189.7, radiusIn: 600, turn: 'right', deltaDeg: 2.8648, spiralDefinition: 'Clothoid', spiralInOut: 'out' }),
  el(5, 0, 'Line', 'Line', 670, 900, { azimuthDeg: 74.6 }),
  el(6, 2, 'Arc', 'Arc', 900, 1050, { radius: 380, turn: 'left', deltaDeg: 22.6155, tangent: 75.98, external: 7.52, chord: 149.0, piStationText: '0+975.98' }),
  el(7, 0, 'Line', 'Line', 1050, 1250.5, { azimuthDeg: 52 }) ];
const curves = [
  { number: 1, groupType: 'SpiralCurveSpiral', startStation: 300, endStation: 670, startStationText: t(300), endStationText: t(670), length: 370, turn: 'right', minRadius: 600, totalDeltaDeg: 29.6028, spiralAIn: 189.7, spiralAOut: 189.7, elementCount: 3 },
  { number: 2, groupType: 'Arc', startStation: 900, endStation: 1050, startStationText: t(900), endStationText: t(1050), length: 150, turn: 'left', minRadius: 380, totalDeltaDeg: 22.6155, spiralAIn: null, spiralAOut: null, elementCount: 1 } ];
const se = [['BeginNormalCrown', 260, -2, -2], ['LevelCrown', 280, 0, -2], ['BeginFullSuper', 360, 6, -6], ['EndFullSuper', 610, 6, -6], ['EndNormalCrown', 710, -2, -2]]
  .map(([type, s, l, r]) => ({ curveName: '곡선 1', station: s, stationText: t(s), type, region: s < 500 ? 'In' : 'Out', leftOutLanePercent: l, rightOutLanePercent: r }));
const sections = { curves, elements, key_points: [], station_equations: [], design_speeds: [{ station: 0, stationText: t(0), speed: 80 }], superelevation: se, offset: [], related: [{ profiles: [ { name: '본선 지반선', handle: 'C1', type: 'EG' }, { name: '본선 계획선', handle: 'C2', type: 'FG' } ], profileViewCount: 1, sampleLineGroups: [], childOffsetAlignments: [] }], design_checks: [] };
export function handle(r) {
  if (r.method.startsWith('profile.')) return handleProfile(r);
  if (r.method === 'alignment.get') return { alignment: summary, settings: { referenceStation: 0, referencePoint: [1000, 2000], stationIndexIncrement: 20, superelevationType: 'Superelevation', useDesignSpeed: true, useDesignCriteriaFile: false, criteriaFileName: null, useDesignCheckSet: false, designCheckSetName: null, isConnected: false },
    sections: Object.fromEntries(Object.entries(sections).map(([k, v]) => [k, v.length])), unavailable: ['design_checks: the alignment does not use a design check set.'] };
  if (r.method === 'alignment.section') {
    const p = r.params, f = p.fromStation, to = p.toStation;
    const items = (sections[p.section] ?? []).filter(i => (i.startStation ?? i.station ?? 0) <= (to ?? 1e9) && (i.endStation ?? i.station ?? 0) >= (f ?? -1e9));
    return { alignmentName: '본선', alignmentHandle: 'B1', section: p.section, fromStation: f ?? null, toStation: to ?? null, offset: 0, limit: 50, totalCount: items.length, items };
  }
}

const pt = s => `${Math.floor(s / 1000)}+${(s % 1000).toFixed(2).padStart(6, '0')}`;
const fgSummary = { name: '본선 계획선', handle: 'C2', type: 'FG', layer: 'C-PROF', startStation: 0, endStation: 1250.5, startStationText: pt(0), endStationText: pt(1250.5), minElevation: 48.0, maxElevation: 56.9, alignmentName: '본선', alignmentHandle: 'B1' };
const egSummary = { name: '본선 지반선', handle: 'C1', type: 'EG', layer: 'C-PROF', startStation: 0, endStation: 1250.5, startStationText: pt(0), endStationText: pt(1250.5), minElevation: 45.2, maxElevation: 61.8, alignmentName: '본선', alignmentHandle: 'B1' };
// FG: 0 (48.0) +2.5% -> VIP 420 (58.5), -1.8% -> VIP 900 (49.86), +0.9% -> 1250.5
const fgElev = s => { // parabolic curves L=160 at 420, L=120 at 900
  const tan = s <= 420 ? 48 + 0.025 * s : s <= 900 ? 58.5 - 0.018 * (s - 420) : 49.86 + 0.009 * (s - 900);
  const curve = (pvi, L, g1, g2) => { const x = s - (pvi - L / 2); return (x > 0 && x < L) ? (g2 - g1) / (2 * L) * x * x : 0; };
  const base = s <= 420 ? 48 + 0.025 * s : s <= 900 ? 58.5 - 0.018 * (s - 420) : 49.86 + 0.009 * (s - 900);
  const yc = (s > 340 && s < 500) ? (48 + 0.025 * s) + curve(420, 160, 0.025, -0.018) : (s > 840 && s < 960) ? (58.5 - 0.018 * (s - 420)) + curve(900, 120, -0.018, 0.009) : base;
  return Math.round(yc * 1000) / 1000; };
const egElev = s => Math.round((45.2 + 8 * Math.sin(s / 200) + s * 0.006) * 1000) / 1000;
const profSections = {
  C2: {
    pvis: [
      { number: 1, station: 0, stationText: pt(0), elevation: 48, gradeInPercent: null, gradeOutPercent: 2.5, curveType: 'None' },
      { number: 2, station: 420, stationText: pt(420), elevation: 58.5, gradeInPercent: 2.5, gradeOutPercent: -1.8, gradeChangePercent: -4.3, curveType: 'ParabolaSymmetric', curveLength: 160, k: 37.21, crestOrSag: 'Crest', stoppingSightDistance: 110 },
      { number: 3, station: 900, stationText: pt(900), elevation: 49.86, gradeInPercent: -1.8, gradeOutPercent: 0.9, gradeChangePercent: 2.7, curveType: 'ParabolaSymmetric', curveLength: 120, k: 44.44, crestOrSag: 'Sag', stoppingSightDistance: 140 },
      { number: 4, station: 1250.5, stationText: pt(1250.5), elevation: 53.0145, gradeInPercent: 0.9, gradeOutPercent: null, curveType: 'None' } ],
    tangents: [
      { number: 1, startStation: 0, endStation: 340, startStationText: pt(0), endStationText: pt(340), startElevation: 48, endElevation: 56.5, length: 340, gradePercent: 2.5 },
      { number: 2, startStation: 500, endStation: 840, startStationText: pt(500), endStationText: pt(840), startElevation: 57.06, endElevation: 50.94, length: 340, gradePercent: -1.8 },
      { number: 3, startStation: 960, endStation: 1250.5, startStationText: pt(960), endStationText: pt(1250.5), startElevation: 50.4, endElevation: 53.0145, length: 290.5, gradePercent: 0.9 } ],
    curves: [
      { number: 1, curveType: 'ParabolaSymmetric', crestOrSag: 'Crest', startStation: 340, endStation: 500, startStationText: pt(340), endStationText: pt(500), length: 160, pviStation: 420, pviStationText: pt(420), pviElevation: 58.5, gradeInPercent: 2.5, gradeOutPercent: -1.8, gradeChangePercent: 4.3, k: 37.21, radius: 3720.9, tangentOffsetAtPvi: 0.86, highLowPoint: { station: 433.02, stationText: pt(433.02), elevation: 57.75 }, minimumKStopping: 45, minimumKPassing: 0, minimumKHeadlight: null, highestDesignSpeed: 80 },
      { number: 2, curveType: 'ParabolaSymmetric', crestOrSag: 'Sag', startStation: 840, endStation: 960, startStationText: pt(840), endStationText: pt(960), length: 120, pviStation: 900, pviStationText: pt(900), pviElevation: 49.86, gradeInPercent: -1.8, gradeOutPercent: 0.9, gradeChangePercent: 2.7, k: 44.44, radius: 4444.4, tangentOffsetAtPvi: 0.405, highLowPoint: { station: 920, stationText: pt(920), elevation: 50.04 }, minimumKStopping: 30, highestDesignSpeed: 80 } ],
    views: [{ name: '본선 종단도', handle: 'D1', startStation: 0, endStation: 1250.5, startStationText: pt(0), endStationText: pt(1250.5), minElevation: 40, maxElevation: 65 }],
    design_checks: []
  },
  C1: { pvis: [], tangents: [], curves: [], views: [], design_checks: [] }
};
export function handleProfile(r) {
  const id = (r.params.profile ?? '').includes('지반') || r.params.profile === 'C1' ? 'C1' : 'C2';
  if (r.method === 'profile.get') {
    const sec = profSections[id];
    return { profile: id === 'C2' ? fgSummary : egSummary,
      settings: { updateMode: id === 'C2' ? 'Static' : 'Dynamic', dataSource: id === 'C1' ? 'EG 지표면' : null, offset: null, parentProfile: null, designSpeedBased: true, useDesignCriteriaFile: false, useDesignCheckSet: false, designCheckSetName: null },
      highest: id === 'C2' ? { station: 433.02, stationText: pt(433.02), elevation: 57.75 } : { station: 330, stationText: pt(330), elevation: 61.8 },
      lowest: id === 'C2' ? { station: 0, stationText: pt(0), elevation: 48 } : { station: 0, stationText: pt(0), elevation: 45.2 },
      sections: Object.fromEntries(Object.entries(sec).map(([k, v]) => [k, v.length])), unavailable: ['design_checks: the profile does not use a design check set.'] };
  }
  if (r.method === 'profile.section') {
    const p = r.params; let items;
    if (p.section === 'elevations') {
      const sts = p.stations?.length ? p.stations : Array.from({ length: Math.floor(((p.toStation ?? 1250.5) - (p.fromStation ?? 0)) / p.interval) + 1 }, (_, i) => (p.fromStation ?? 0) + i * p.interval);
      const f = id === 'C2' ? fgElev : egElev;
      items = sts.map(s => ({ station: s, stationText: pt(s), elevation: s >= 0 && s <= 1250.5 ? f(s) : null, gradePercent: null }));
    } else items = (profSections[id][p.section] ?? []).filter(i => (i.startStation ?? i.station ?? 0) <= (p.toStation ?? 1e9) && (i.endStation ?? i.station ?? 0) >= (p.fromStation ?? -1e9));
    return { profileName: id === 'C2' ? '본선 계획선' : '본선 지반선', profileHandle: id, alignmentName: '본선', section: p.section, totalCount: items.length, offset: 0, limit: 50, items };
  }
}

// change.apply: mimics DesignChanges.cs (checks "from", then sets the value).
export function applyChanges(r) {
  const out = [];
  for (const c of r.params.changes) {
    let get, set;
    if (c.kind === 'profileCurve' && c.property === 'length') {
      const cv = profSections.C2.curves.find(x => Math.abs(x.pviStation - c.at) < 0.01);
      get = () => cv.length; set = v => { cv.length = v; cv.k = Math.round(v / cv.gradeChangePercent * 100) / 100; cv.startStation = cv.pviStation - v / 2; cv.endStation = cv.pviStation + v / 2; cv.startStationText = pt(cv.startStation); cv.endStationText = pt(cv.endStation); };
    } else if (c.kind === 'profilePvi' && c.property === 'elevation') {
      const p = profSections.C2.pvis.find(x => Math.abs(x.station - c.at) < 0.01);
      get = () => p.elevation; set = v => { p.elevation = v; };
    } else if (c.kind === 'alignmentArc' && c.property === 'radius') {
      const e = sections.elements.find(x => x.kind === 'Arc' && Math.abs(x.startStation - c.at) < 0.01);
      const cg = sections.curves.find(x => x.number === e.curveGroup);
      get = () => e.radius; set = v => { e.radius = v; cg.minRadius = v; };
    } else throw new Error(`${c.kind}.${c.property} 변경은 아직 자동으로 적용할 수 없습니다.`);
    const before = get();
    if (c.from != null && Math.abs(before - c.from) > 0.001) throw new Error(`${c.kind} ${c.property} 값이 ${before}로 바뀌어 있어 적용하지 않았습니다(수정안 기준 ${c.from}). 다시 검토하세요.`);
    set(c.to); out.push({ kind: c.kind, handle: c.handle, at: c.at, property: c.property, before, after: get() });
  }
  return { changes: out, revision: 'sess1-' + Date.now() };
}
