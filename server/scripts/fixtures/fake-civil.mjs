// A fake Civil 3D plug-in bridge for tests: the 본선 alignment and its profiles
// (fake-alignment.mjs), five polylines and alignment creation (fake-polyline.mjs).
import { createServer } from 'node:net';
import { writeFileSync } from 'node:fs';
import { applyChanges, handle as handleAlignment } from './fake-alignment.mjs';
import { handlePolyline } from './fake-polyline.mjs';

const token = 'a'.repeat(64);
const alignments = { drawingName: 'FAKE-SITE.dwg', offset: 0, limit: 200, totalCount: 2, items: [
  { name: '본선', handle: 'B1', type: 'Centerline' }, { name: 'A램프', handle: 'B2', type: 'Centerline' }] };

function answer(request) {
  switch (request.method) {
    case 'change.apply': return applyChanges(request);
    case 'drawing.status': return { drawingName: 'FAKE-SITE.dwg', filePath: 'D:/fake/FAKE-SITE.dwg', civilDocumentAvailable: true, revision: 'sess1-42' };
    case 'alignment.list': return handlePolyline(request) ?? alignments;
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
