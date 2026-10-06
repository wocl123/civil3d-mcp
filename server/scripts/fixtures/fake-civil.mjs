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

// The drawing's revision, which the plug-in raises on every edit; tests raise it after a fake user edit.
export function bumpRevision() { revision++; }

// Handles the fake drawing has selected, as a user selecting before asking.
export function setSelection(handles) { selected = handles; }
const alignments = { drawingName: 'FAKE-SITE.dwg', offset: 0, limit: 200, totalCount: 2, items: [
  { name: '본선', handle: 'B1', type: 'Centerline', layer: 'C-ROAD-CL', startStation: 0, endStation: 1500, length: 1500,
    startStationText: '0+000.00', endStationText: '1+500.00', profileCount: 2, description: '용도: 도로' },
  { name: 'A램프', handle: 'B2', type: 'Centerline', layer: 'C-ROAD-CL', startStation: 0, endStation: 1500, length: 1500,
    startStationText: '0+000.00', endStationText: '1+500.00', profileCount: 2, description: '용도: 도로' }] };

function answer(request) {
  switch (request.method) {
    case 'change.apply': return applyChanges(request);
    case 'drawing.summary': return { drawingName: 'FAKE-SITE.dwg', objectCount: 1240,
      byType: [{ name: 'Solid3d', count: 900 }, { name: 'Line', count: 210 }, { name: 'Pipe', count: 106 }, { name: 'Structure', count: 107 }],
      typeCount: 4, byLayer: [{ name: '우수받이', count: 700 }, { name: 'C-STRM', count: 213 }], layerCount: 2,
      civil: { alignments: 2, alignmentTypes: { Centerline: 2 }, profiles: 2, cogoPoints: 0, surfaces: [{ name: '지반', type: 'TinSurface' }], surfaceCount: 1,
        pipeNetworks: [{ name: '우수관망', type: 'PipeNetwork', first: 106, second: 107 }], pipeNetworkCount: 1, corridors: [], corridorCount: 0, sites: [], siteCount: 0 },
      unavailable: [] };
    case 'drawing.status': return { drawingName: 'FAKE-SITE.dwg', filePath: 'D:/fake/FAKE-SITE.dwg', civilDocumentAvailable: true, revision: `sess1-${revision}` };
    case 'alignment.list': return handlePolyline(request) ?? alignments;
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
      catch (error) { reply = { error: { code: -32000, message: error.message } }; }
      socket.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, ...reply }) + '\n');
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    writeFileSync(connectionFile, JSON.stringify({ port: server.address().port, token }));
    resolve(server);
  }));
}
