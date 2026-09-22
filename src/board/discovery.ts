import type { Pool } from "pg";
import { BOARD_SIZE, ORBITS, orbitAt } from "../config.js";
import type { Orbit } from "../config.js";

/**
 * Finding a planet, and knowing how much ground is left.
 *
 * A board of a few hundred planets is browsable; a full one is not, and neither
 * is one where the only way in is to recognise an avatar. Search and categories
 * are what keep it a directory rather than a wall.
 *
 * The scarcity side is the same data read the other way round: what is left in
 * each orbit, which is the honest version of a countdown because it is counted
 * rather than set.
 */

export const CATEGORIES = [
  "art",
  "music",
  "film",
  "writing",
  "gaming",
  "tech",
  "design",
  "fitness",
  "food",
  "travel",
  "fashion",
  "finance",
  "comedy",
  "education",
  "science",
  "photography",
  "podcast",
  "other",
] as const;

export type Category = (typeof CATEGORIES)[number];

export function isCategory(value: unknown): value is Category {
  return typeof value === "string" && (CATEGORIES as readonly string[]).includes(value);
}

/**
 * How many tiles each orbit holds.
 *
 * Counted once from the same function the rest of the application uses, rather
 * than asked of the database on every request: it is a property of the geometry
 * and the geometry does not change while the process is running. The database
 * is asked only for what is taken, which is small and does change.
 */
const CAPACITY: ReadonlyMap<string, number> = (() => {
  const counts = new Map<string, number>();
  for (const orbit of ORBITS) counts.set(orbit.name, 0);

  for (let x = 0; x < BOARD_SIZE; x += 1) {
    for (let y = 0; y < BOARD_SIZE; y += 1) {
      const orbit = orbitAt(x, y);
      if (orbit === null) continue;
      counts.set(orbit.name, (counts.get(orbit.name) ?? 0) + 1);
    }
  }
  return counts;
})();

export interface OrbitAvailability {
  readonly name: string;
  readonly label: string;
  readonly centsPerTilePerMonth: number;
  readonly maxSize: number;
  readonly capacity: number;
  readonly taken: number;
  readonly remaining: number;
  /** 0..1, for a bar that does not need the caller to do arithmetic. */
  readonly fraction: number;
}

/**
 * What is left, per orbit.
 *
 * Grouped by `orbit_of()` rather than by anything stored on the row, so a tile
 * cannot be counted against an orbit it does not sit in. Reservations count as
 * taken: they hold the tile, and telling someone a square is free when it is
 * held for the next quarter of an hour is how a checkout ends in a conflict.
 */
export async function orbitAvailability(pool: Pool): Promise<OrbitAvailability[]> {
  const result = await pool.query<{ orbit: string; taken: string }>(
    `SELECT orbit_of(x::numeric, y::numeric) AS orbit, count(*)::text AS taken
       FROM occupied_tiles
      GROUP BY 1`,
  );

  const taken = new Map(result.rows.map((row) => [row.orbit, Number(row.taken)]));

  return ORBITS.map((orbit: Orbit) => {
    const capacity = CAPACITY.get(orbit.name) ?? 0;
    const held = Math.min(taken.get(orbit.name) ?? 0, capacity);
    return {
      name: orbit.name,
      label: orbit.label,
      centsPerTilePerMonth: orbit.centsPerTilePerMonth,
      maxSize: orbit.maxSize,
      capacity,
      taken: held,
      remaining: capacity - held,
      fraction: capacity === 0 ? 0 : held / capacity,
    };
  });
}

export interface DirectoryEntry {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly size: number;
  readonly name: string;
  readonly handle: string;
  readonly description: string | null;
  readonly category: Category | null;
  readonly aura: string;
  readonly imageUrl: string | null;
  readonly clicks: number;
}

export interface DirectoryQuery {
  readonly text?: string;
  readonly category?: Category;
  readonly limit?: number;
  readonly offset?: number;
}

export interface DirectoryPage {
  readonly entries: DirectoryEntry[];
  readonly total: number;
}

/**
 * The directory listing, filtered and searched.
 *
 * `websearch_to_tsquery` rather than `to_tsquery`, because this is fed straight
 * from a text box and `to_tsquery` raises a syntax error on anything a person
 * would actually type. Only live planets are listed: a reserved one is not
 * public yet, and a lapsed one is already gone from the board.
 */
export async function searchDirectory(pool: Pool, query: DirectoryQuery = {}): Promise<DirectoryPage> {
  const text = query.text?.trim() ?? "";
  const limit = Math.max(1, Math.min(100, Math.trunc(query.limit ?? 40)));
  const offset = Math.max(0, Math.trunc(query.offset ?? 0));

  const result = await pool.query<{
    id: string;
    x: number;
    y: number;
    size: number;
    name: string;
    handle: string;
    description: string | null;
    category: Category | null;
    aura: string;
    image_url: string | null;
    click_count: number;
    total: string;
  }>(
    `SELECT id, x, y, size, display_name AS name, handle, description, category, aura,
            image_url, click_count, count(*) OVER ()::text AS total
       FROM blocks
      WHERE status = 'live'
        AND ($1 = '' OR search @@ websearch_to_tsquery('simple', $1))
        AND ($2::planet_category IS NULL OR category = $2::planet_category)
      -- Bigger planets first, because they paid for the prominence, then by the
      -- traffic they actually pull rather than by when they arrived.
      ORDER BY size DESC, click_count DESC, published_at DESC
      LIMIT $3 OFFSET $4`,
    [text, query.category ?? null, limit, offset],
  );

  return {
    total: Number(result.rows[0]?.total ?? 0),
    entries: result.rows.map((row) => ({
      id: row.id,
      x: row.x,
      y: row.y,
      size: row.size,
      name: row.name,
      handle: row.handle,
      description: row.description,
      category: row.category,
      aura: row.aura,
      imageUrl: row.image_url,
      clicks: row.click_count,
    })),
  };
}

export interface CategoryCount {
  readonly category: Category;
  readonly count: number;
}

/** Only categories that have something in them; an empty filter is a dead end. */
export async function categoryCounts(pool: Pool): Promise<CategoryCount[]> {
  const result = await pool.query<{ category: Category; count: string }>(
    `SELECT category, count(*)::text AS count
       FROM blocks
      WHERE status = 'live' AND category IS NOT NULL
      GROUP BY category
      ORDER BY count(*) DESC, category`,
  );
  return result.rows.map((row) => ({ category: row.category, count: Number(row.count) }));
}
