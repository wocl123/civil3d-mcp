// drawing.capture for the fake Civil 3D: draws the polylines (grey) and the created
// alignments (yellow, with their curves as arcs) into a PNG, framed like the plug-in does.
import { deflateSync } from 'node:zlib';

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = bytes => { let c = 0xffffffff; for (const b of bytes) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };

function png(width, height, pixels) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0); body.copy(out, 4); out.writeUInt32BE(crc(body), body.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) pixels.copy(raw, y * (width * 3 + 1) + 1, y * width * 3, (y + 1) * width * 3);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// Sample points of an alignment: straights between tangent points, and each curve as an arc
// (spirals are drawn as part of the arc, which is close enough to look at).
function alignmentPoints({ points, curves }) {
  const out = [points[0]];
  for (let i = 1; i < points.length - 1; i++) {
    const [a, b, c] = [points[i - 1], points[i], points[i + 1]];
    const curve = curves[i - 1] ?? {};
    if (!curve.radius) { out.push(b); continue; }
    const u1 = norm(b.x - a.x, b.y - a.y), u2 = norm(c.x - b.x, c.y - b.y);
    const delta = Math.atan2(u1.x * u2.y - u1.y * u2.x, u1.x * u2.x + u1.y * u2.y);
    const tangent = curve.radius * Math.tan(Math.abs(delta) / 2);
    const start = { x: b.x - u1.x * tangent, y: b.y - u1.y * tangent };
    const side = Math.sign(delta);
    const center = { x: start.x - u1.y * curve.radius * side, y: start.y + u1.x * curve.radius * side };
    const from = Math.atan2(start.y - center.y, start.x - center.x);
    for (let k = 0; k <= 24; k++) {
      const angle = from + delta * k / 24;
      out.push({ x: center.x + curve.radius * Math.cos(angle), y: center.y + curve.radius * Math.sin(angle) });
    }
  }
  out.push(points.at(-1));
  return out;
}
const norm = (x, y) => { const l = Math.hypot(x, y); return { x: x / l, y: y / l }; };

export function capture({ width = 800, height = 600, handles = [] }, polylines, alignments) {
  const lines = [
    ...Object.entries(polylines).map(([handle, p]) => ({ handle, color: [170, 170, 170], points: p.vertices.map(([x, y]) => ({ x, y })) })),
    ...alignments.map(a => ({ handle: a.handle, color: [255, 220, 0], points: alignmentPoints(a.req) }))
  ];
  const framed = handles.length ? lines.filter(line => handles.includes(line.handle)) : lines;
  if (handles.length && !framed.length) throw new Error('None of the objects to frame was found.');
  const all = framed.flatMap(line => line.points);
  const [minX, maxX] = [Math.min(...all.map(p => p.x)), Math.max(...all.map(p => p.x))];
  const [minY, maxY] = [Math.min(...all.map(p => p.y)), Math.max(...all.map(p => p.y))];
  let fieldWidth = Math.max(maxX - minX, 1) * 1.16, fieldHeight = Math.max(maxY - minY, 1) * 1.16;
  if (fieldWidth / fieldHeight < width / height) fieldWidth = fieldHeight * width / height; else fieldHeight = fieldWidth * height / width;
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const toPixel = p => [Math.round((p.x - cx) / fieldWidth * width + width / 2), Math.round(height / 2 - (p.y - cy) / fieldHeight * height)];

  const pixels = Buffer.alloc(width * height * 3);
  const plot = (x, y, color) => {
    for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
      const px = x + dx, py = y + dy;
      if (px >= 0 && py >= 0 && px < width && py < height) pixels.set(color, (py * width + px) * 3);
    }
  };
  for (const line of lines)
    for (let i = 1; i < line.points.length; i++) {
      const [x0, y0] = toPixel(line.points[i - 1]), [x1, y1] = toPixel(line.points[i]);
      const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
      for (let s = 0; s <= steps; s++) plot(Math.round(x0 + (x1 - x0) * s / steps), Math.round(y0 + (y1 - y0) * s / steps), line.color);
    }
  const round = v => Math.round(v * 1000) / 1000;
  return { width, height, png: png(width, height, pixels).toString('base64'),
    area: [round(cx - fieldWidth / 2), round(cy - fieldHeight / 2), round(cx + fieldWidth / 2), round(cy + fieldHeight / 2)],
    framed: framed.map(line => line.handle) };
}
