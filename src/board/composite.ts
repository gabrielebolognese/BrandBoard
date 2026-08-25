import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { Pool } from "pg";
import sharp from "sharp";
import type { OverlayOptions, Sharp } from "sharp";
import { BOARD_SIZE, TILE_INSET, TILE_PIXELS } from "../config.js";
import { boardVersion } from "./manifest.js";

export const BOARD_PIXELS = BOARD_SIZE * TILE_PIXELS; // 2400

/**
 * The worlds, and only the worlds.
 *
 * A block is a planet, but only the picture changes. A planet still occupies an N x N square of tiles
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
      layers.push({
        input: await renderPlanet(avatar, rect.side),
        left: rect.left,
        top: rect.top,
      });
    } catch {
      // A missing avatar must not blank the sky. Leave the orbit empty and let
      // the review queue be the place that catches bad listings.
    }
  }

  const webp = await emptySky()
    .composite(layers)
    .webp({ quality: 88, alphaQuality: 90 })
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
export async function renderPlanet(avatar: Buffer, diameter: number): Promise<Buffer> {
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

/**
 * Nothing at all, at board size, for the planets to sit on.
 *
 * Hard discs over transparency, which is what compresses: the alpha is flat
 * everywhere except a few hundred antialiased edges. Soft halos were baked in
 * here at first and cost more than the planets, the stars and the nebulae put
 * together, so the client draws them from one cached sprite instead.
 *
 * The sky is not in here either. Painting it in made the universe a rectangle
 * that stopped at its own edge; it belongs to the client, which can draw it
 * across the whole viewport however far anyone scrolls.
 */
function emptySky(): Sharp {
  return sharp({
    create: {
      width: BOARD_PIXELS,
      height: BOARD_PIXELS,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  });
}
