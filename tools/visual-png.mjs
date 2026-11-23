// Chromium screenshots are non-interlaced 8-bit RGB/RGBA PNGs. Compare decoded pixels, not compressed bytes.
import { crc32, deflateSync, inflateSync } from 'node:zlib';

const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function paeth(a, b, c) {
  const p = a + b - c;
  const da = Math.abs(p - a), db = Math.abs(p - b), dc = Math.abs(p - c);
  return da <= db && da <= dc ? a : db <= dc ? b : c;
}

export function decodePng(png) {
  if (!png.subarray(0, 8).equals(signature)) throw new Error('Not a PNG');
  let width, height, channels, ended = false;
  const chunks = [];
  for (let i = 8; i + 12 <= png.length;) {
    const len = png.readUInt32BE(i), type = png.toString('ascii', i + 4, i + 8);
    const end = i + 8 + len;
    if (end + 4 > png.length) throw new Error(`Truncated PNG ${type} chunk`);
    if (crc32(png.subarray(i + 4, end)) !== png.readUInt32BE(end)) throw new Error(`Invalid PNG ${type} checksum`);
    const data = png.subarray(i + 8, end);
    if (type === 'IHDR') {
      if (len !== 13 || i !== 8) throw new Error('Invalid PNG header');
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      channels = data[9] === 2 ? 3 : data[9] === 6 ? 4 : 0;
      if (!width || !height || data[8] !== 8 || !channels || data[10] || data[11] || data[12]) {
        throw new Error('Expected a non-interlaced 8-bit RGB/RGBA PNG');
      }
    } else if (type === 'IDAT') chunks.push(data);
    else if (type === 'tRNS') throw new Error('PNG color-key transparency is not supported');
    else if (type === 'IEND') { ended = true; break; }
    i = end + 4;
  }
  if (!channels || !chunks.length || !ended) throw new Error('Incomplete PNG');
  const stride = width * channels, row = stride + 1;
  const raw = inflateSync(Buffer.concat(chunks), { maxOutputLength: row * height });
  if (raw.length !== row * height) throw new Error('Unexpected PNG scanline length');
  const rgba = Buffer.allocUnsafe(width * height * 4);
  let out = 0;
  for (let y = 0; y < height; y++) {
    const start = y * row + 1, filter = raw[start - 1];
    if (filter > 4) throw new Error(`Unknown PNG filter ${filter}`);
    for (let x = 0; x < stride; x++) {
      const i = start + x;
      const a = x >= channels ? raw[i - channels] : 0;
      const b = y ? raw[i - row] : 0;
      const c = y && x >= channels ? raw[i - row - channels] : 0;
      raw[i] += filter === 1 ? a : filter === 2 ? b : filter === 3 ? (a + b) >> 1 : filter === 4 ? paeth(a, b, c) : 0;
      rgba[out++] = raw[i];
      if (channels === 3 && x % 3 === 2) rgba[out++] = 255;
    }
  }
  return { width, height, rgba };
}

function chunk(type, data) {
  const buf = Buffer.alloc(data.length + 12);
  buf.writeUInt32BE(data.length, 0);
  buf.write(type, 4, 'ascii');
  data.copy(buf, 8);
  buf.writeUInt32BE(crc32(buf.subarray(4, -4)), buf.length - 4);
  return buf;
}

export function encodePng({ width, height, rgba }) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  return Buffer.concat([signature, chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

export function comparePixels(expected, actual) {
  const width = Math.max(expected.width, actual.width), height = Math.max(expected.height, actual.height);
  const sizeChanged = expected.width !== actual.width || expected.height !== actual.height;
  if (!sizeChanged && expected.rgba.equals(actual.rgba)) return { changed: 0, total: width * height, failed: false };
  const rgba = Buffer.allocUnsafe(width * height * 4);
  let changed = 0;
  for (let y = 0, out = 0; y < height; y++) {
    for (let x = 0; x < width; x++, out += 4) {
      const a = y < expected.height && x < expected.width ? (y * expected.width + x) * 4 : -1;
      const b = y < actual.height && x < actual.width ? (y * actual.width + x) * 4 : -1;
      if (a !== b && (a < 0 || b < 0) || (a >= 0 && b >= 0 && expected.rgba.readUInt32LE(a) !== actual.rgba.readUInt32LE(b))) {
        changed++;
        rgba[out] = 255; rgba[out + 1] = 0; rgba[out + 2] = 106;
      } else {
        const gray = b < 0 ? 0 : 32 + ((actual.rgba[b] + actual.rgba[b + 1] + actual.rgba[b + 2]) >> 3);
        rgba[out] = rgba[out + 1] = rgba[out + 2] = gray;
      }
      rgba[out + 3] = 255;
    }
  }
  const total = width * height;
  return { changed, total, sizeChanged, failed: sizeChanged || changed * 1000 > total, diff: { width, height, rgba } };
}
