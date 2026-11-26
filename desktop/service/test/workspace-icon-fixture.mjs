import { deflateSync } from 'node:zlib';

export function iconPng({ opaque = false, empty = false, filter = 0, size = 4 } = {}) {
  const crc = buffer => { let value = -1; for (const byte of buffer) { value ^= byte; for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0); } return (value ^ -1) >>> 0; };
  const chunk = (type, data) => { const bytes = Buffer.concat([Buffer.from(type), data]), size = Buffer.alloc(4), checksum = Buffer.alloc(4); size.writeUInt32BE(data.length); checksum.writeUInt32BE(crc(bytes)); return Buffer.concat([size, bytes, checksum]); };
  const header = Buffer.alloc(13); header.writeUInt32BE(size); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6;
  const raw = [], rows = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(size * 4);
    for (let x = 0; x < size; x++) row.set([120, 180, 220, empty ? 0 : opaque || x >= size / 4 && x < size * 3 / 4 && y >= size / 4 && y < size * 3 / 4 ? 255 : 0], x * 4);
    const previous = rows[y - 1] || Buffer.alloc(size * 4), encoded = Buffer.alloc(size * 4 + 1); encoded[0] = filter;
    for (let x = 0; x < size * 4; x++) {
      const a = x < 4 ? 0 : row[x - 4], b = previous[x], c = x < 4 ? 0 : previous[x - 4], p = a + b - c;
      const distances = [Math.abs(p - a), Math.abs(p - b), Math.abs(p - c)];
      const predictor = filter === 0 ? 0 : filter === 1 ? a : filter === 2 ? b : filter === 3 ? Math.floor((a + b) / 2) : distances[0] <= distances[1] && distances[0] <= distances[2] ? a : distances[1] <= distances[2] ? b : c;
      encoded[x + 1] = (row[x] - predictor) & 255;
    }
    rows.push(row); raw.push(encoded);
  }
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.concat(raw))), chunk('IEND', Buffer.alloc(0))]);
}
export const iconDataUrl = options => `data:image/png;base64,${iconPng(options).toString('base64')}`;
