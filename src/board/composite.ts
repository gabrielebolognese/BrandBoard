import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { Pool } from "pg";
import sharp from "sharp";
import type { OverlayOptions } from "sharp";
import { BOARD_SIZE, TILE_INSET, TILE_PIXELS, TILE_SQUARE } from "../config.js";
import { boardVersion } from "./manifest.js";

export const BOARD_PIXELS = BOARD_SIZE * TILE_PIXELS; // 2400

/**
 * Where a block's avatar bytes come from. Dev reads the seeded files off disk;
 * step 4 swaps in object storage without touching the compositing code.
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

/** The pixel square a block occupies, inset so neighbours never touch. */
export function blockRect(x: number, y: number, size: number) {
  return {
    left: x * TILE_PIXELS + TILE_INSET,
    top: y * TILE_PIXELS + TILE_INSET,
    side: size * TILE_PIXELS - 2 * TILE_INSET,
  };
}

let cached: CompositeBoard | null = null;

/**
 * The composite board image: every live avatar flattened into one 2400x2400
 * WebP. This is what a visitor's browser paints, so the board appears in a
 * single request instead of ten thousand.
 *
 * Three layers: the empty grid, the avatars, then a one pixel border around
 * each live block so an occupied square is as crisply bounded as an empty one.
 */
export async function getCompositeBoard(
  pool: Pool,
  avatars: AvatarStore,
): Promise<CompositeBoard> {
  const version = await boardVersion(pool);
  if (cached !== null && cached.version === version) return cached;

  const live = await pool.query<{ id: string; x: number; y: number; size: number; image_url: string }>(
    `SELECT id, x, y, size, image_url
       FROM blocks
      WHERE status = 'live' AND image_url IS NOT NULL
      ORDER BY x, y`,
  );

  const layers: OverlayOptions[] = [];
  const borders: string[] = [];

  for (const block of live.rows) {
    const rect = blockRect(block.x, block.y, block.size);
    try {
      const avatar = await avatars.read(block.image_url);
      layers.push({
        input: await sharp(avatar).resize(rect.side, rect.side, { fit: "cover" }).toBuffer(),
        left: rect.left,
        top: rect.top,
      });
      borders.push(
        `<rect x="${rect.left + 0.5}" y="${rect.top + 0.5}" ` +
          `width="${rect.side - 1}" height="${rect.side - 1}" ` +
          `fill="none" stroke="rgba(255,255,255,0.16)" stroke-width="1"/>`,
      );
    } catch {
      // A missing avatar must not blank the whole board. Leave the square empty
      // and let the review queue be the place that catches bad listings.
    }
  }

  if (borders.length > 0) {
    layers.push({ input: svg(borders.join("")), left: 0, top: 0 });
  }

  const webp = await sharp(baseBoard())
    .composite(layers)
    .webp({ quality: 90, alphaQuality: 100 })
    .toBuffer();

  cached = { version, webp, blocks: live.rows.length };
  return cached;
}

/** Forget the cached image; used after seeding. */
export function invalidateCompositeBoard(): void {
  cached = null;
}

/**
 * The empty board: one 20px square per tile, each with its own 1px border and
 * 2px of ground around it. Drawn as a tiling pattern rather than ten thousand
 * rects, which keeps the SVG tiny and the render fast.
 */
function baseBoard(): Buffer {
  return svg(
    `<defs>
       <pattern id="tile" width="${TILE_PIXELS}" height="${TILE_PIXELS}" patternUnits="userSpaceOnUse">
         <rect x="${TILE_INSET + 0.5}" y="${TILE_INSET + 0.5}"
               width="${TILE_SQUARE - 1}" height="${TILE_SQUARE - 1}"
               fill="#121821" stroke="#222c3b" stroke-width="1"/>
       </pattern>
     </defs>
     <rect width="100%" height="100%" fill="#080a0e"/>
     <rect width="100%" height="100%" fill="url(#tile)"/>`,
  );
}

function svg(body: string): Buffer {
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${BOARD_PIXELS}" height="${BOARD_PIXELS}">${body}</svg>`,
  );
}
