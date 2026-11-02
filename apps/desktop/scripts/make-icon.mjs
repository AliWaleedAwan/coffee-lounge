/**
 * Draws the app icon with no outside tools, so it can be rebuilt anywhere: a cream cup with
 * steam on an espresso tile, from the staff app's colours. Small sizes drop the steam, which
 * would only blur. Writes assets/icon.ico (every size Windows asks for) and assets/icon.png.
 *   node scripts/make-icon.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256];
const SAMPLES = 6;
const TOP = [122, 79, 60];
const BOTTOM = [62, 37, 27];
const CREAM = [250, 241, 228];
const COFFEE = [150, 98, 70];

/** Distance-style tests on a 0..1 canvas. */
function roundRect(x, y, x0, y0, x1, y1, r) {
  const dx = Math.max(x0 + r - x, 0, x - (x1 - r));
  const dy = Math.max(y0 + r - y, 0, y - (y1 - r));
  return x >= x0 && x <= x1 && y >= y0 && y <= y1 && dx * dx + dy * dy <= r * r;
}
const ring = (x, y, cx, cy, outer, inner) => {
  const d = Math.hypot(x - cx, y - cy);
  return d <= outer && d >= inner;
};
/** The cup: straight at the rim, curving in to a round base. */
function cup(x, y) {
  if (y < 0.44 || y > 0.76) return false;
  const t = (y - 0.44) / 0.32;
  const half = 0.2 * Math.sqrt(1 - t ** 4) + 0.001;
  return Math.abs(x - 0.46) <= half;
}
function steam(x, y, cx) {
  if (y < 0.17 || y > 0.37) return false;
  const middle = cx + 0.022 * Math.sin(((y - 0.17) / 0.2) * Math.PI * 2);
  return Math.abs(x - middle) <= 0.016;
}

/** The colour at one point, or null outside the tile. */
function colour(x, y, withSteam) {
  if (!roundRect(x, y, 0, 0, 1, 1, 0.22)) return null;
  const inCoffee = y >= 0.44 && y <= 0.49 && Math.abs(x - 0.46) <= 0.175;
  if (inCoffee) return COFFEE;
  const handle = x > 0.6 && ring(x, y, 0.645, 0.555, 0.075, 0.04);
  const saucer = roundRect(x, y, 0.2, 0.79, 0.72, 0.83, 0.02);
  const drawn =
    cup(x, y) || handle || saucer || (withSteam && (steam(x, y, 0.39) || steam(x, y, 0.53)));
  if (drawn) return CREAM;
  return TOP.map((c, i) => c + (BOTTOM[i] - c) * y);
}

function render(size) {
  const data = Buffer.alloc(size * size * 4);
  const withSteam = size >= 32;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const sum = [0, 0, 0];
      let hits = 0;
      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const c = colour(
            (px + (sx + 0.5) / SAMPLES) / size,
            (py + (sy + 0.5) / SAMPLES) / size,
            withSteam,
          );
          if (!c) continue;
          hits += 1;
          for (let i = 0; i < 3; i++) sum[i] += c[i];
        }
      }
      const at = (py * size + px) * 4;
      for (let i = 0; i < 3 && hits; i++) data[at + i] = Math.round(sum[i] / hits);
      data[at + 3] = Math.round((hits / SAMPLES ** 2) * 255);
    }
  }
  return data;
}

const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function chunk(type, body) {
  const head = Buffer.concat([Buffer.from(type, 'ascii'), body]);
  let c = 0xffffffff;
  for (const b of head) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  const out = Buffer.alloc(head.length + 8);
  out.writeUInt32BE(body.length, 0);
  head.copy(out, 4);
  out.writeUInt32BE((c ^ 0xffffffff) >>> 0, head.length + 4);
  return out;
}
function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const rows = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    rgba.copy(rows, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(rows, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const images = SIZES.map((size) => ({ size, bytes: png(size, render(size)) }));
const header = Buffer.alloc(6 + 16 * images.length);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(images.length, 4);
let offset = header.length;
images.forEach(({ size, bytes }, i) => {
  const at = 6 + 16 * i;
  header[at] = size === 256 ? 0 : size;
  header[at + 1] = size === 256 ? 0 : size;
  header.writeUInt16LE(1, at + 4);
  header.writeUInt16LE(32, at + 6);
  header.writeUInt32LE(bytes.length, at + 8);
  header.writeUInt32LE(offset, at + 12);
  offset += bytes.length;
});
const dir = join(fileURLToPath(new URL('..', import.meta.url)), 'assets');
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, 'icon.ico'), Buffer.concat([header, ...images.map((i) => i.bytes)]));
writeFileSync(join(dir, 'icon.png'), images.at(-1).bytes);
