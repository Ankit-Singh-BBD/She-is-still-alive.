/**
 * Her icons, generated rather than drawn.
 *
 * ## Why this file exists at all
 *
 * `index.html` and `public/manifest.webmanifest` need a PNG at three sizes. A PNG is a
 * binary asset, which normally means either a design tool in the loop or an image
 * library in `package.json` — and the mandate for this project is to avoid dependencies
 * that are not earned. So this writes the PNGs itself: `node:zlib` for the one hard part
 * (deflate) and about forty lines for the container.
 *
 * The reason it is worth the forty lines is not the dependency. It is that the icon is
 * *her colours*, and her colours have exactly one origin — `server/environment/palette.ts`.
 * An icon exported from a design tool is a sixth hand-copied night palette that nothing
 * can check. This one calls `derivePalette('night', 'unknown')`, the same call
 * `mood.ts` makes before the first read and the same one the stylesheet's `@property`
 * initial values are pinned to, so the icon cannot drift from the room it opens into.
 *
 * ## What it draws
 *
 * The composition is the same one the shader draws: her ground, one soft orb a little
 * above centre, a wide halo in the secondary, a warmer core. Nothing else — at 48
 * device pixels in a task switcher an icon with detail in it is an icon with mud in it.
 *
 * Two variants, because Android crops:
 *  - `icon-192.png` / `icon-512.png` — `purpose: any`. The orb fills the frame.
 *  - `icon-maskable-512.png` — `purpose: maskable`. The platform may crop to a circle
 *    of 80% diameter and anything outside it is not guaranteed to survive, so the orb
 *    is pulled in to sit safely inside that circle. The ground is full-bleed in both,
 *    which is what makes the crop invisible.
 *
 * Run with `npm run icons`. Deterministic: same palette in, same bytes out, so it is
 * safe to commit the results and safe to re-run in CI to prove they were not edited.
 */

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { derivePalette } from '../server/environment/palette.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ICONS = join(HERE, '..', 'public', 'icons');

/** sRGB, 0..1. The same convention `src/lib/palette.ts` uses. */
type Rgb = readonly [number, number, number];

function hexToRgb(hex: string): Rgb {
  const value = Number.parseInt(hex.trim().replace(/^#/, ''), 16);
  return [((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255];
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

function mix(a: Rgb, b: Rgb, t: number): Rgb {
  const k = clamp01(t);
  return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
}

// ---------------------------------------------------------------------------
// PNG container
// ---------------------------------------------------------------------------

/** CRC-32, as PNG defines it (IEEE 802.3, reflected). Table built once. */
const CRC_TABLE = ((): Uint32Array => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) === 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Buffer): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = (CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8)) >>> 0;
  return (c ^ 0xffffffff) >>> 0;
}

/** One PNG chunk: length, four-byte type, payload, CRC over type+payload. */
function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([head, body, crc]);
}

/**
 * An opaque truecolour PNG from packed RGB bytes.
 *
 * Colour type 2 (RGB, no alpha) on purpose: the design is a full-bleed ground, an
 * `apple-touch-icon` must be opaque anyway, and a maskable icon with transparency
 * shows the launcher's own background through the crop. Filter 0 on every scanline —
 * the image is a smooth gradient, so a predictive filter would buy a few hundred bytes
 * and cost the ability to read this function at a glance.
 */
function png(width: number, height: number, rgb: Uint8Array): Buffer {
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(rgb.buffer, rgb.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// The picture
// ---------------------------------------------------------------------------

const PALETTE = derivePalette('night', 'unknown');
const GROUND = mix(hexToRgb(PALETTE.primary), [0, 0, 0], 0.55); // the stylesheet's `--ground`
const SECONDARY = hexToRgb(PALETTE.secondary);
const ACCENT = hexToRgb(PALETTE.accent);
const CORE = mix(ACCENT, [1, 1, 1], 0.62);

/** Where the orb sits and how wide it is, in fractions of the shorter side. */
interface Composition {
  readonly radius: number;
  readonly centreY: number;
}

/**
 * One pixel of the field, in sRGB.
 *
 * `x`/`y` are 0..1 across the image. The falloffs are gaussians rather than
 * `smoothstep` because a gaussian has no edge at all — at 48 pixels any hard boundary
 * reads as a ring.
 */
function field(x: number, y: number, { radius, centreY }: Composition): Rgb {
  const dx = (x - 0.5) / radius;
  const dy = (y - centreY) / radius;
  const d2 = dx * dx + dy * dy;

  const halo = Math.exp(-d2 * 0.55) * 0.42;
  const orb = Math.exp(-d2 * 3.1);
  const core = Math.exp(-d2 * 13.0);

  let colour = mix(GROUND, SECONDARY, halo);
  colour = mix(colour, ACCENT, orb * 0.94);
  colour = mix(colour, CORE, core * 0.66);

  // A vignette measured from the centre of the square, not of the orb, so the corners
  // fall away evenly and the crop a launcher applies has nothing to reveal.
  const vx = x - 0.5;
  const vy = y - 0.5;
  const vignette = 1 - clamp01(vx * vx + vy * vy) * 0.5;
  return [colour[0] * vignette, colour[1] * vignette, colour[2] * vignette];
}

/** 3×3 supersampling. Cheap here, and the difference is visible at 192. */
function render(size: number, composition: Composition): Uint8Array {
  const out = new Uint8Array(size * size * 3);
  const STEPS = 3;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let sy = 0; sy < STEPS; sy++) {
        for (let sx = 0; sx < STEPS; sx++) {
          const [cr, cg, cb] = field(
            (px + (sx + 0.5) / STEPS) / size,
            (py + (sy + 0.5) / STEPS) / size,
            composition,
          );
          r += cr;
          g += cg;
          b += cb;
        }
      }
      const n = STEPS * STEPS;
      const at = (py * size + px) * 3;
      out[at] = Math.round(clamp01(r / n) * 255);
      out[at + 1] = Math.round(clamp01(g / n) * 255);
      out[at + 2] = Math.round(clamp01(b / n) * 255);
    }
  }
  return out;
}

/** The orb reaches the frame. */
const FULL: Composition = { radius: 0.34, centreY: 0.46 };
/** Pulled inside the 80%-diameter circle a maskable icon may be cropped to. */
const SAFE: Composition = { radius: 0.26, centreY: 0.48 };

const WRITTEN: string[] = [];

function emit(name: string, size: number, composition: Composition): void {
  const file = join(ICONS, name);
  writeFileSync(file, png(size, size, render(size, composition)));
  WRITTEN.push(`${name} (${size}×${size})`);
}

/**
 * The SVG `index.html` prefers.
 *
 * A browser that can take an SVG favicon gets a resolution-independent one, and it is
 * built from the same three colours by construction rather than by hand. The two
 * `radialGradient`s stand in for the gaussians above — close enough at favicon size,
 * and an SVG cannot express a gaussian without a filter.
 */
function svg(): string {
  const hex = ([r, g, b]: Rgb): string =>
    `#${[r, g, b].map((c) => Math.round(clamp01(c) * 255).toString(16).padStart(2, '0')).join('')}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" role="img" aria-label="Madhurita">
  <defs>
    <radialGradient id="halo" cx="50%" cy="46%" r="62%">
      <stop offset="0%" stop-color="${hex(SECONDARY)}" stop-opacity="0.85" />
      <stop offset="100%" stop-color="${hex(GROUND)}" stop-opacity="0" />
    </radialGradient>
    <radialGradient id="orb" cx="50%" cy="46%" r="34%">
      <stop offset="0%" stop-color="${hex(CORE)}" />
      <stop offset="42%" stop-color="${hex(ACCENT)}" />
      <stop offset="100%" stop-color="${hex(ACCENT)}" stop-opacity="0" />
    </radialGradient>
  </defs>
  <rect width="512" height="512" fill="${hex(GROUND)}" />
  <rect width="512" height="512" fill="url(#halo)" />
  <rect width="512" height="512" fill="url(#orb)" />
</svg>
`;
}

mkdirSync(ICONS, { recursive: true });
emit('icon-192.png', 192, FULL);
emit('icon-512.png', 512, FULL);
emit('icon-maskable-512.png', 512, SAFE);
writeFileSync(join(ICONS, 'icon.svg'), svg(), 'utf8');
WRITTEN.push('icon.svg');

console.log(`[icons] ${PALETTE.primary} / ${PALETTE.secondary} / ${PALETTE.accent}`);
console.log(`[icons] wrote ${WRITTEN.join(', ')} to public/icons/`);
