import { mkdir, writeFile } from "node:fs/promises";
import type { Pool } from "pg";
import { claimBlock } from "./board/claim.js";
import { avatarPixelsFor, generateAvatar } from "./board/avatar.js";
import { invalidateCompositeBoard } from "./board/composite.js";
import { TileConflictError } from "./board/errors.js";
import {
  BOARD_CENTER,
  UNIVERSE_RADIUS,
  featuredPriceCents,
  fitsInUniverse,
  isSizeAllowedAt,
} from "./config.js";

/**
 * Fills the board with plausible fake listings so the rendering work has
 * something to render. Blocks are claimed through the real claim transaction
 * rather than inserted directly, so seeding cannot produce a board state the
 * product could not reach on its own.
 */

const FIRST = [
  "Ava", "Milo", "Nina", "Theo", "Iris", "Kai", "Luca", "Mara", "Otis", "Sena",
  "Rui", "Ines", "Bex", "Dara", "Ezra", "Fumi", "Gia", "Hugo", "Ida", "Jax",
  "Noor", "Omar", "Pia", "Quinn", "Remy", "Suki", "Tariq", "Uma", "Vero", "Wren",
];

const LAST = [
  "Stone", "Vega", "Marsh", "Okoye", "Lindqvist", "Reyes", "Sato", "Fenn", "Duarte",
  "Bishop", "Novak", "Rossi", "Adeyemi", "Kaur", "Beaumont", "Halvorsen", "Costa",
  "Yilmaz", "Nakamura", "Ferreira",
];

const CATEGORIES = [
  "Fitness", "Music", "Tech", "Art", "Gaming", "Food", "Finance", "Comedy", "Fashion",
  "Travel", "Film", "Writing",
];

const PLATFORMS = ["x", "instagram", "youtube", "tiktok", "twitch", "newsletter"] as const;

/** Deterministic PRNG so a reseed produces the same board. */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

export interface SeedResult {
  readonly blocks: number;
  readonly tiles: number;
  readonly attempts: number;
}

export async function seedBoard(
  pool: Pool,
  avatarDir: URL,
  target = 420,
  seed = 20260824,
): Promise<SeedResult> {
  await mkdir(avatarDir, { recursive: true });
  const random = makeRandom(seed);

  const userId = await seedUser(pool, random);

  let blocks = 0;
  let tiles = 0;
  let attempts = 0;
  const usedHandles = new Set<string>();

  while (blocks < target && attempts < target * 12) {
    attempts += 1;

    const size = pickSize(random);
    // Somewhere in the disc, packed toward the core and thinning outwards, the
    // way a universe priced by proximity would actually fill.
    const spot = pickSpot(random, size);
    if (spot === null) continue;
    const { x, y } = spot;

    const first = pick(random, FIRST);
    const last = pick(random, LAST);
    const handle = uniqueHandle(`${first}${last}`.toLowerCase(), usedHandles);

    try {
      const block = await claimBlock(pool, userId, { x, y, size });
      const initials = `${first[0] ?? "?"}${last[0] ?? "?"}`;
      const avatar = await generateAvatar(handle, initials, avatarPixelsFor(size));
      await writeFile(new URL(`${block.id}.webp`, avatarDir), avatar);

      await publish(pool, block.id, {
        name: `${first} ${last}`,
        handle,
        imageUrl: `/avatars/${block.id}.webp`,
        category: pick(random, CATEGORIES),
        links: pickLinks(random, handle),
      });

      blocks += 1;
      tiles += size * size;
    } catch (error) {
      // The square was taken. Pick another; that is all a conflict means here.
      if (!(error instanceof TileConflictError)) throw error;
      usedHandles.delete(handle);
    }
  }

  await seedFeatured(pool, random);

  invalidateCompositeBoard();
  return { blocks, tiles, attempts };
}

/**
 * Featured windows, deliberately staggered.
 *
 * Bought at different moments in the recent past with different lengths, so the
 * column shows five unrelated countdowns rather than five identical ones. This
 * is the whole point of the model: no shared reset, one clock per purchase.
 *
 * Inserted directly rather than through featureBlock() because that always
 * starts at now(), and a demo board wants windows already partway through.
 */
async function seedFeatured(pool: Pool, random: () => number): Promise<void> {
  const live = await pool.query<{ id: string }>(
    `SELECT id FROM blocks WHERE status = 'live' ORDER BY size DESC, published_at DESC LIMIT 5`,
  );

  let boughtHoursAgo = 1;
  for (const block of live.rows) {
    const days = 1 + Math.floor(random() * 4);
    await pool.query(
      `INSERT INTO featured_slots (block_id, days, price_cents, starts_at, expires_at)
       VALUES ($1, $2::int, $3,
               now() - make_interval(hours => $4::int),
               now() - make_interval(hours => $4::int) + make_interval(days => $2::int))`,
      [block.id, days, featuredPriceCents(days), boughtHoursAgo],
    );
    boughtHoursAgo += 3 + Math.floor(random() * 6);
  }
}

interface Listing {
  readonly name: string;
  readonly handle: string;
  readonly imageUrl: string;
  readonly category: string;
  readonly links: Record<string, string>;
}

/**
 * Seeded blocks go straight to live. Real ones cannot: payment moves them to
 * pending_review and an admin publishes them (invariant 4).
 */
async function publish(pool: Pool, blockId: string, listing: Listing): Promise<void> {
  await pool.query(
    `UPDATE blocks
        SET status = 'live',
            reserved_until = NULL,
            published_at = now(),
            display_name = $2,
            handle = $3,
            image_url = $4,
            primary_url = $5,
            category = $6,
            links = $7::jsonb,
            click_count = $8
      WHERE id = $1`,
    [
      blockId,
      listing.name,
      listing.handle,
      listing.imageUrl,
      listing.links["x"] ?? `https://example.com/${listing.handle}`,
      listing.category,
      JSON.stringify(listing.links),
      0,
    ],
  );
}

async function seedUser(pool: Pool, random: () => number): Promise<string> {
  const suffix = Math.floor(random() * 1e6);
  const result = await pool.query<{ id: string }>(
    `INSERT INTO users (x_handle, x_user_id)
     VALUES ($1, $2)
     ON CONFLICT (x_user_id) DO UPDATE SET x_handle = EXCLUDED.x_handle
     RETURNING id`,
    ["seed", `seed-${suffix}`],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error("could not create the seed user");
  return row.id;
}

/**
 * Mostly small, with the occasional large block, since there is no cap. The
 * tail is what proves the board handles sizes beyond the old 5x5 limit.
 */
function pickSize(random: () => number): number {
  const roll = random();
  if (roll < 0.40) return 1;
  if (roll < 0.64) return 2;
  if (roll < 0.80) return 3;
  if (roll < 0.90) return 4;
  if (roll < 0.96) return 5;
  return 6 + Math.floor(random() * 8); // 6 through 13, trimmed by the orbit
}

function pick<T>(random: () => number, values: readonly T[]): T {
  const value = values[Math.floor(random() * values.length)];
  if (value === undefined) throw new Error("empty pick list");
  return value;
}

function pickLinks(random: () => number, handle: string): Record<string, string> {
  const links: Record<string, string> = {};
  const count = 1 + Math.floor(random() * 3);
  const pool = [...PLATFORMS];
  for (let i = 0; i < count && pool.length > 0; i += 1) {
    const index = Math.floor(random() * pool.length);
    const [platform] = pool.splice(index, 1);
    if (platform === undefined) continue;
    links[platform] = `https://${platform}.example/${handle}`;
  }
  return links;
}

function gaussian(random: () => number, mean: number, spread: number): number {
  const u = Math.max(random(), 1e-9);
  const v = random();
  const normal = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  return mean + normal * spread;
}

/**
 * A free-ish anchor inside the disc.
 *
 * Radius is drawn from a square root of a biased roll, which concentrates
 * planets near the centre without leaving the outer reach empty: the core is
 * five times the price and should look like it is worth it.
 */
function pickSpot(random: () => number, size: number): { x: number; y: number } | null {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const angle = random() * Math.PI * 2;
    const bias = random() ** 2.1;
    const radius = Math.sqrt(bias) * (UNIVERSE_RADIUS - size - 1);
    const x = Math.round(BOARD_CENTER + Math.cos(angle) * radius) - Math.floor(size / 2);
    const y = Math.round(BOARD_CENTER + Math.sin(angle) * radius) - Math.floor(size / 2);
    if (x < 0 || y < 0) continue;
    // The orbit a spot lands in decides how big a planet it will take, so a
    // seeded planet has to satisfy the same rule a bought one does.
    if (fitsInUniverse(x, y, size) && isSizeAllowedAt(x, y, size)) return { x, y };
  }
  return null;
}

function uniqueHandle(base: string, used: Set<string>): string {
  let handle = base;
  let n = 2;
  while (used.has(handle)) {
    handle = `${base}${n}`;
    n += 1;
  }
  used.add(handle);
  return handle;
}
