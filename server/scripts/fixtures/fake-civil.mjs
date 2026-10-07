// A fake Civil 3D plug-in bridge for tests: the 본선 alignment and its profiles
// (fake-alignment.mjs), five polylines and alignment creation (fake-polyline.mjs).
import { createServer } from 'node:net';
import { writeFileSync } from 'node:fs';
import { applyChanges, handle as handleAlignment } from './fake-alignment.mjs';
import { capture } from './fake-capture.mjs';
import { created, handlePolyline, polylines } from './fake-polyline.mjs';

const token = 'a'.repeat(64);
let selected = [];
let revision = 42;
let drawingId = 'fake-drawing-1';
const operations = new Map();
const removed = new Set();   // handles deleted with drawing.delete
const failures = new Map();
export function setDrawing(id) { drawingId = id; }
export function failMethod(method, message) { if (message) failures.set(method, message); else failures.delete(method); }


// The drawing's revision, which the plug-in raises on every edit; tests raise it after a fake user edit.
export function bumpRevision() { revision++; }

// Handles the fake drawing has selected, as a user selecting before asking.
export function setSelection(handles) { selected = handles; }
const alignments = { drawingName: 'FAKE-SITE.dwg', offset: 0, limit: 200, totalCount: 2, items: [
  { name: '본선', handle: 'B1', type: 'Centerline', layer: 'C-ROAD-CL', startStation: 0, endStation: 1500, length: 1500,
    startStationText: '0+000.00', endStationText: '1+500.00', profileCount: 2, description: '용도: 도로' },
  { name: 'A램프', handle: 'B2', type: 'Centerline', layer: 'C-ROAD-CL', startStation: 0, endStation: 1500, length: 1500,
    startStationText: '0+000.00', endStationText: '1+500.00', profileCount: 2, description: '용도: 도로' }] };

// A corridor whose baseline is A램프.
const corridor = { name: 'A램프 코리더', handle: 'C1', alignments: ['A램프'], surfaces: ['A램프 상면'] };

// Like DrawingDeletion.cs: alignments by name or handle (or all), each with its two profiles and the corridors that use it.
function deletePreview(params) {
  const keys = params.allAlignments ? alignments.items.map(item => item.handle) : params.alignments ?? [];
  const items = [], notFound = [];
  for (const key of keys) {
    const item = alignments.items.find(a => !removed.has(a.handle) && (a.handle === key || a.name === key));
    if (!item) { notFound.push(`${key}: Alignment '${key}' was not found.`); continue; }
    items.push({ kind: 'alignment', name: item.name, handle: item.handle, profiles: ['EG', 'FG'], profileViews: 1,
      sampleLineGroups: [], offsetAlignments: [],
      corridors: item.handle === 'B2' && !removed.has(corridor.handle) ? [corridor] : [] });
  }
  return { items, notFound };
}

function answer(request) {
  if (failures.has(request.method)) throw new Error(failures.get(request.method));
  if (request.context && (request.context.drawingId !== drawingId || request.context.revision !== `sess1-${revision}`))
    throw new Error('Drawing changed since the calculation started. Run the check again.');
  if (request.method === 'change.cancel') {
    const id = request.params.operationId;
    if (!operations.has(id)) operations.set(id, { operationId: id, drawingId, revision: `sess1-${revision}`, state: 'cancelled' });
    return operations.get(id);
  }
  if (request.method === 'change.result') {
    const entry = operations.get(request.params.operationId);
    if (!entry || entry.drawingId !== drawingId) throw new Error('operation missing');
    return entry;
  }
  if (request.method === 'change.undo') {
    const entry = operations.get(request.params.operationId);
    if (!entry || entry.drawingId !== drawingId) throw new Error('drawing mismatch');
    if (entry.state === 'undone') return entry;
    if (entry.revision !== `sess1-${revision}`) throw new Error('undo conflict: drawing changed');
    if (entry.deleted) entry.deleted.forEach(target => removed.delete(target.handle));
    else if (entry.name) created.delete(entry.name);
    else applyChanges({ params: { changes: entry.originalChanges.map((c, i) => ({ ...c, from: entry.changes[i].after, to: entry.changes[i].before })) } });
    revision++;
    entry.state = 'undone'; entry.revision = `sess1-${revision}`;
    return entry;
  }
  if (request.method === 'change.apply' || request.method === 'alignment.create' || request.method === 'drawing.delete') {
    const id = request.params.operationId;
    if (!request.context) throw new Error('missing drawing context');
    if (operations.get(id)?.state === "cancelled") throw new Error("operation cancelled");
    if (operations.has(id)) return operations.get(id);
    const result = request.method === 'change.apply' ? applyChanges(request)
      : request.method === 'drawing.delete' ? deleteTargets(request.params.targets)
      : handlePolyline(request);
    revision++;
    const receipt = { ...result, operationId: id, drawingId, revision: `sess1-${revision}`, state: 'applied', originalChanges: request.params.changes };
    operations.set(id, receipt);
    if (failures.has("after.commit")) throw new Error(failures.get("after.commit"));
    return receipt;
  }
  switch (request.method) {

    case 'drawing.summary': return { drawingName: 'FAKE-SITE.dwg', objectCount: 1240,
      byType: [{ name: 'Solid3d', count: 900 }, { name: 'Line', count: 210 }, { name: 'Pipe', count: 106 }, { name: 'Structure', count: 107 }],
      typeCount: 4, byLayer: [{ name: '우수받이', count: 700 }, { name: 'C-STRM', count: 213 }], layerCount: 2,
      civil: { alignments: 2, alignmentTypes: { Centerline: 2 }, profiles: 2, cogoPoints: 0, surfaces: [{ name: '지반', type: 'TinSurface' }], surfaceCount: 1,
        pipeNetworks: [{ name: '우수관망', type: 'PipeNetwork', first: 106, second: 107 }], pipeNetworkCount: 1, corridors: [], corridorCount: 0, sites: [], siteCount: 0 },
      unavailable: [] };
    case 'drawing.status': return { drawingName: 'FAKE-SITE.dwg', filePath: 'D:/fake/FAKE-SITE.dwg', civilDocumentAvailable: true, protocolVersion: 2, drawingId, revision: `sess1-${revision}` };
    case 'alignment.list': return handlePolyline(request) ?? { ...alignments, items: alignments.items.filter(item => !removed.has(item.handle)) };
    case 'drawing.delete_preview': return deletePreview(request.params ?? {});
    case 'drawing.capture': return capture(request.params ?? {}, polylines, [...created.values()]);
    case 'drawing.selection': {
      // Like the plug-in: every object counted by type and layer, the first 20 in detail.
      const all = selected.map(handle => {
        const polyline = handlePolyline({ method: 'drawing.polylines', params: { limit: 50 } }).items.find(item => item.handle === handle);
        if (polyline) return { handle, type: 'Polyline', layer: polyline.layer, name: null, polyline };
        if (handle.startsWith('S')) return { handle, type: 'Solid3d', layer: handle < 'S5' ? '우수받이' : '터파기 토사', name: null, polyline: null };
        return { handle, type: 'Alignment', layer: 'C-ROAD-CL', name: '본선', polyline: null };
      });
      const count = key => Object.entries(all.reduce((map, item) => ({ ...map, [item[key]]: (map[item[key]] ?? 0) + 1 }), {}))
        .sort((a, b) => b[1] - a[1]).map(([name, n]) => ({ name, count: n }));
      return { drawingName: 'FAKE-SITE.dwg', totalCount: all.length, byType: count('type'), byLayer: count('layer'), items: all.slice(0, 20) };
    }
    default: return handlePolyline(request) ?? handleAlignment(request) ?? { totalCount: 0, items: [] };
  }
}

// Starts the bridge and writes the connection file the server reads.
export function startFakeCivil(connectionFile) {
  const server = createServer(socket => {
    let line = '';
    socket.on('data', chunk => {
      line += chunk;
      if (!line.includes('\n')) return;
      const request = JSON.parse(line.slice(0, line.indexOf('\n')));
      let reply;
      try { reply = { result: answer(request) }; }
      catch (error) { reply = { error: { code: -32000, message: error.message, drawingChanged: failures.has("after.commit") ? "unknown" : false } }; }
      socket.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, ...reply }) + '\n');
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    writeFileSync(connectionFile, JSON.stringify({ port: server.address().port, token }));
    resolve(server);
  }));
}

// Like DrawingDeletion.Delete: refuses a target whose name changed since the preview,
// and an alignment whose corridor is not deleted with it.
function deleteTargets(targets) {
  for (const target of targets) {
    const item = target.kind === 'corridor' ? (removed.has(corridor.handle) ? undefined : corridor)
      : alignments.items.find(a => a.handle === target.handle && !removed.has(a.handle));
    if (!item || item.name !== target.name) throw new Error(`${target.name}이(가) 미리 본 뒤 바뀌어 있어 적용하지 않았습니다. 다시 확인하세요.`);
    if (target.handle === 'B2' && !removed.has(corridor.handle) && !targets.some(other => other.handle === corridor.handle))
      throw new Error(`${target.name}은(는) 코리더 ${corridor.name}에서 쓰여 지우지 않았습니다. 다시 확인하세요.`);
  }
  targets.forEach(target => removed.add(target.handle));
  const lines = targets.filter(target => target.kind === 'alignment').length;
  return { deleted: targets, profiles: lines * 2, profileViews: lines, corridors: targets.length - lines };
}
