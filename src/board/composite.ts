import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { Pool } from "pg";
import sharp from "sharp";
import type { OverlayOptions } from "sharp";
import { BOARD_SIZE, TILE_INSET, TILE_PIXELS } from "../config.js";
import { boardVersion } from "./manifest.js";

export const BOARD_PIXELS = BOARD_SIZE * TILE_PIXELS; // 2400

/**
 * The board is a universe and a block is a planet.
 *
 * Only the picture changes. A planet still occupies an N x N square of tiles
 * anchored at (x, y), still cannot overlap another, and is still governed by
 * occupied_tiles. The circle is inscribed in that square, so everything that
 * reasons about geometry keeps reasoning in tiles and none of it needed to know
 * about any of this.
 */

export interface AvatarStore {
  read(imageUrl: string): Promise<Buffer>;
}

export function localAvatarStore(directory: URL): AvatarStore {
  return {
    async read(imageUrl: string): Promise<Buffer> {
      // basename() so a crafted image_url cannot walk out of the directory.
      return readFile(new URL(basename(imageUrl), directory));
    },
  };
}

export interface CompositeBoard {
  readonly version: string;
  readonly webp: Buffer;
  readonly blocks: number;
}

/** The pixel square a planet occupies, inset so neighbours never touch. */
export function blockRect(x: number, y: number, size: number) {
  return {
    left: x * TILE_PIXELS + TILE_INSET,
    top: y * TILE_PIXELS + TILE_INSET,
    side: size * TILE_PIXELS - 2 * TILE_INSET,
  };
}

let cached: CompositeBoard | null = null;
let inFlight: { version: string; work: Promise<CompositeBoard> } | null = null;

export async function getCompositeBoard(
  pool: Pool,
  avatars: AvatarStore,
): Promise<CompositeBoard> {
  const version = await boardVersion(pool);
  if (cached !== null && cached.version === version) return cached;
  if (inFlight !== null && inFlight.version === version) return inFlight.work;

  const work = renderBoard(pool, avatars, version);
  inFlight = { version, work };
  try {
    cached = await work;
    return cached;
  } finally {
    if (inFlight?.version === version) inFlight = null;
  }
}

export function invalidateCompositeBoard(): void {
  cached = null;
  inFlight = null;
}

async function renderBoard(
  pool: Pool,
  avatars: AvatarStore,
  version: string,
): Promise<CompositeBoard> {
  const live = await pool.query<{
    id: string;
    x: number;
    y: number;
    size: number;
    image_url: string;
    handle: string | null;
  }>(
    `SELECT id, x, y, size, image_url, handle
       FROM blocks
      WHERE status = 'live' AND image_url IS NOT NULL
      ORDER BY size DESC, x, y`,
  );

  const layers: OverlayOptions[] = [];

  for (const block of live.rows) {
    const rect = blockRect(block.x, block.y, block.size);
    try {
      const avatar = await avatars.read(block.image_url);
      const glow = glowFor(rect.side);

      // Halo first, then the lit body over it.
      layers.push({
        input: glow.buffer,
        left: rect.left - glow.pad,
        top: rect.top - glow.pad,
      });
      layers.push({
        input: await planet(avatar, rect.side),
        left: rect.left,
        top: rect.top,
      });
    } catch {
      // A missing avatar must not blank the sky. Leave the orbit empty and let
      // the review queue be the place that catches bad listings.
    }
  }

  const webp = await sharp(deepSpace())
    .composite(layers)
    .webp({ quality: 88, alphaQuality: 100 })
    .toBuffer();

  return { version, webp, blocks: live.rows.length };
}

/**
 * One planet: the avatar clipped to a sphere, then lit.
 *
 * The mask and the shading depend only on the diameter, and there are at most
 * twenty five of those, so both are built once and reused. Without that this
 * would rasterise two SVGs per planet on every render.
 */
async function planet(avatar: Buffer, diameter: number): Promise<Buffer> {
  return sharp(avatar)
    .resize(diameter, diameter, { fit: "cover" })
    .ensureAlpha()
    .composite([
      { input: maskFor(diameter), blend: "dest-in" },
      { input: shadingFor(diameter), blend: "over" },
    ])
    .png()
    .toBuffer();
}

const masks = new Map<number, Buffer>();
const shadings = new Map<number, Buffer>();
const glows = new Map<number, { buffer: Buffer; pad: number }>();

function maskFor(diameter: number): Buffer {
  const existing = masks.get(diameter);
  if (existing !== undefined) return existing;

  const r = diameter / 2;
  const buffer = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${diameter}" height="${diameter}">
       <circle cx="${r}" cy="${r}" r="${r}" fill="#fff"/>
     </svg>`,
  );
  masks.set(diameter, buffer);
  return buffer;
}

/**
 * What makes a flat disc read as a sphere: a highlight up and to the left, the
 * body falling into shadow away from it, and a thin rim light on the far edge
 * where a star behind would catch the limb.
 */
function shadingFor(diameter: number): Buffer {
  const existing = shadings.get(diameter);
  if (existing !== undefined) return existing;

  const r = diameter / 2;
  const buffer = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${diameter}" height="${diameter}">
       <defs>
         <radialGradient id="lit" cx="34%" cy="28%" r="78%">
           <stop offset="0%"   stop-color="#ffffff" stop-opacity="0.42"/>
           <stop offset="34%"  stop-color="#ffffff" stop-opacity="0.10"/>
           <stop offset="72%"  stop-color="#000010" stop-opacity="0.34"/>
           <stop offset="100%" stop-color="#000008" stop-opacity="0.72"/>
         </radialGradient>
         <radialGradient id="rim" cx="50%" cy="50%" r="50%">
           <stop offset="86%"  stop-color="#8fc7ff" stop-opacity="0"/>
           <stop offset="97%"  stop-color="#bfe0ff" stop-opacity="0.55"/>
           <stop offset="100%" stop-color="#bfe0ff" stop-opacity="0"/>
         </radialGradient>
       </defs>
       <circle cx="${r}" cy="${r}" r="${r}" fill="url(#lit)"/>
       <circle cx="${r}" cy="${r}" r="${r}" fill="url(#rim)"/>
     </svg>`,
  );
  shadings.set(diameter, buffer);
  return buffer;
}

/** The atmosphere a planet sits in, so it glows rather than being pasted on. */
function glowFor(diameter: number): { buffer: Buffer; pad: number } {
  const existing = glows.get(diameter);
  if (existing !== undefined) return existing;

  const pad = Math.max(6, Math.round(diameter * 0.42));
  const span = diameter + pad * 2;
  const c = span / 2;
  const inner = (diameter / 2 / c) * 100;

  const buffer = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${span}" height="${span}">
       <defs>
         <radialGradient id="halo" cx="50%" cy="50%" r="50%">
           <stop offset="${(inner * 0.9).toFixed(1)}%" stop-color="#6fa8ff" stop-opacity="0.30"/>
           <stop offset="${inner.toFixed(1)}%"        stop-color="#6fa8ff" stop-opacity="0.20"/>
           <stop offset="100%"                        stop-color="#6fa8ff" stop-opacity="0"/>
         </radialGradient>
       </defs>
       <circle cx="${c}" cy="${c}" r="${c}" fill="url(#halo)"/>
     </svg>`,
  );

  const entry = { buffer, pad };
  glows.set(diameter, entry);
  return entry;
}

/**
 * Empty space: deep black, nebulae, and a great many distant stars.
 *
 * Opaque on purpose. An alpha channel here, so a live starfield could show
 * through from behind, quadrupled the file to a megabyte: soft halos over
 * transparency compress terribly. The canvas gets the same effect for nothing
 * by drawing its moving stars on top and skipping the ones that land on a
 * planet, which it can test in constant time against the tile index it already
 * keeps.
 *
 * No grid. Where a tile can be bought is shown by the cursor while placing, not
 * by drawing ten thousand boxes across the sky.
 *
 * Deliberately no grid. Where a tile can be bought is shown by the cursor while
 * placing, not by drawing ten thousand boxes over the sky.
 *
 * Seeded, so the same sky comes back on every render and the image can be
 * cached against the board version rather than changing on every request.
 */
function deepSpace(): Buffer {
  const random = seeded(0x5eed_1e55);
  const stars: string[] = [];

  for (let i = 0; i < 1500; i += 1) {
    const x = (random() * BOARD_PIXELS).toFixed(1);
    const y = (random() * BOARD_PIXELS).toFixed(1);
    const roll = random();
    // Mostly faint pinpricks, a few bright ones, fewer still with any size.
    const r = roll > 0.985 ? 1.9 : roll > 0.93 ? 1.25 : roll > 0.7 ? 0.85 : 0.55;
    const opacity = (0.18 + random() * 0.72).toFixed(2);
    const tint = roll > 0.9 ? "#cfe4ff" : roll > 0.8 ? "#ffe9d0" : "#ffffff";
    stars.push(`<circle cx="${x}" cy="${y}" r="${r}" fill="${tint}" opacity="${opacity}"/>`);
  }

  const nebulae: string[] = [];
  const hues = [232, 268, 198, 312, 210];
  for (let i = 0; i < hues.length; i += 1) {
    const cx = (random() * BOARD_PIXELS).toFixed(0);
    const cy = (random() * BOARD_PIXELS).toFixed(0);
    const r = (BOARD_PIXELS * (0.18 + random() * 0.22)).toFixed(0);
    nebulae.push(
      `<radialGradient id="neb${i}" cx="50%" cy="50%" r="50%">
         <stop offset="0%" stop-color="hsl(${hues[i]} 70% 52%)" stop-opacity="0.16"/>
         <stop offset="55%" stop-color="hsl(${hues[i]} 70% 40%)" stop-opacity="0.06"/>
         <stop offset="100%" stop-color="hsl(${hues[i]} 70% 30%)" stop-opacity="0"/>
       </radialGradient>`,
    );
    nebulae.push(`<circle cx="${cx}" cy="${cy}" r="${r}" fill="url(#neb${i})" data-nebula="1"/>`);
  }

  const defs = nebulae.filter((part) => part.startsWith("<radialGradient")).join("");
  const shapes = nebulae.filter((part) => !part.startsWith("<radialGradient")).join("");

  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${BOARD_PIXELS}" height="${BOARD_PIXELS}">
       <defs>${defs}</defs>
       <rect width="100%" height="100%" fill="#01020a"/>
       ${shapes}
       ${stars.join("")}
     </svg>`,
  );
}

/** Deterministic, so the sky is stable across renders. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

/** Kept for callers that want a stable per-handle hue. */
export function hueFor(value: string): number {
  const hash = createHash("sha1").update(value).digest();
  return ((hash[0] ?? 0) / 255) * 360;
}
