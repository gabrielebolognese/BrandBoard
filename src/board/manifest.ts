import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { BOARD_SIZE, TILE_COUNT } from "../config.js";

/**
 * Exactly the fields the board needs to draw and hit-test. Everything else
 * about a listing is fetched on demand, because this payload is downloaded by
 * every visitor and a full board has to stay under 500KB gzipped.
 */
export interface ManifestBlock {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly size: number;
  readonly name: string;
  readonly handle: string;
  readonly url: string;
}

export interface BoardManifest {
  readonly version: string;
  readonly boardSize: number;
  readonly blocks: ManifestBlock[];
}

/**
 * Changes whenever the set of live blocks changes, which is the only thing that
 * alters the board. Used as the ETag for both the manifest and the composite
 * image, so publishing a block busts exactly those two caches and nothing else.
 */
export async function boardVersion(pool: Pool): Promise<string> {
  const result = await pool.query<{ live: string; latest: string | null }>(
    `SELECT count(*)::text AS live, max(published_at)::text AS latest
       FROM blocks WHERE status = 'live'`,
  );
  const row = result.rows[0];
  const seed = `${row?.live ?? "0"}:${row?.latest ?? "none"}`;
  return createHash("sha1").update(seed).digest("hex").slice(0, 16);
}

export async function buildManifest(pool: Pool): Promise<BoardManifest> {
  const [version, blocks] = await Promise.all([
    boardVersion(pool),
    pool.query<ManifestBlock>(
      `SELECT id, x, y, size, display_name AS name, handle, primary_url AS url
         FROM blocks
        WHERE status = 'live'
        ORDER BY x, y`,
    ),
  ]);

  return { version, boardSize: BOARD_SIZE, blocks: blocks.rows };
}

/**
 * Availability as a bitmap: one bit per tile, set when the tile is held by any
 * block that is not expired or rejected -- reserved and pending_review hold
 * their tiles too, so they must read as taken.
 *
 * 10,000 bits is 1,250 bytes, which is why this is a bitmap and not a list of
 * coordinates. It only feeds the hover ghost; the server is still the only
 * authority on what is free (invariant 3).
 */
export async function availabilityBitmap(pool: Pool): Promise<Buffer> {
  const bitmap = Buffer.alloc(Math.ceil(TILE_COUNT / 8));
  const held = await pool.query<{ x: number; y: number }>(`SELECT x, y FROM occupied_tiles`);

  for (const { x, y } of held.rows) {
    const index = y * BOARD_SIZE + x;
    const byte = index >> 3;
    bitmap[byte] = (bitmap[byte] ?? 0) | (1 << (index & 7));
  }
  return bitmap;
}

/** Held-tile count, for the stats row. */
export async function heldTileCount(pool: Pool): Promise<number> {
  const result = await pool.query<{ count: string }>(`SELECT count(*) FROM occupied_tiles`);
  return Number(result.rows[0]?.count ?? 0);
}
