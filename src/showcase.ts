import { mkdir, writeFile } from "node:fs/promises";
import type { Pool } from "pg";
import { avatarPixelsFor, generateAvatar } from "./board/avatar.js";
import { claimBlock } from "./board/claim.js";
import { invalidateCompositeBoard } from "./board/composite.js";
import { TileConflictError } from "./board/errors.js";
import { AURAS, ORBITS } from "./config.js";
import { seedBoard } from "./seed.js";

/**
 * A board worth looking at.
 *
 * The ordinary seeder fills the universe with plausible listings, which proves
 * the rendering works but does not show what the product is. Every planet comes
 * out the same colour, nothing has a description, every click counter reads
 * zero, and the three orbits are only distinguishable by how tightly the
 * planets are packed.
 *
 * This is the version for looking at: one anchor planet at each orbit's size
 * cap so the ceilings are visible, all seven auras in play so the rings read as
 * rings, real descriptions so search finds something, click counts that vary so
 * the directory has an order, and a couple of broken links so the health
 * warning is not a thing you have to take on faith.
 */

const ANCHORS = [
  {
    orbit: "core",
    name: "Vela Moreau",
    handle: "velamoreau",
    category: "music",
    description: "Modular synth records, made in one take and never edited.",
    aura: "violet",
    clicks: 4820,
  },
  {
    orbit: "inner",
    name: "Casper Oyelaran",
    handle: "casperoyelaran",
    category: "design",
    description: "Type design and lettering. Twelve years of it, mostly serifs.",
    aura: "cyan",
    clicks: 3140,
  },
  {
    orbit: "outer",
    name: "Juno Vasquez",
    handle: "junovasquez",
    category: "photography",
    description: "Long exposures of places that are usually dark.",
    aura: "amber",
    clicks: 1260,
  },
] as const;

const BLURBS = [
  "Weekly essays on the things nobody writes down.",
  "Building in public, mistakes included.",
  "Field recordings from wherever I happen to be standing.",
  "Drawing one impossible building every morning.",
  "Cooking from books nobody has reprinted since 1974.",
  "Explaining the maths I wish somebody had explained to me.",
  "Running slowly, over long distances, on purpose.",
  "Interviews with people who quit something important.",
  "Restoring film cameras and selling them to strangers.",
  "Short stories, roughly one a fortnight.",
  "Teaching guitar to adults who think it is too late.",
  "Notes on typography, kerning and other arguments.",
  "A newsletter about trains that are no longer running.",
  "Woodwork, mostly joints, occasionally furniture.",
  "Sourdough, and the arguments it causes.",
  "Charting every bird I see from one window.",
];

export interface ShowcaseResult {
  readonly blocks: number;
  readonly tiles: number;
  readonly anchors: number;
  readonly auras: number;
}

/**
 * Wipes the board and fills it with the demonstration set.
 *
 * Destructive by design: it is the button labelled "fill the board", and a
 * version that added to what was already there would drift further from a
 * showcase every time it was pressed. The caller decides whether this database
 * is one that may be wiped.
 */
export async function fillShowcase(
  pool: Pool,
  avatarDir: URL,
  target = 520,
): Promise<ShowcaseResult> {
  await mkdir(avatarDir, { recursive: true });

  await pool.query(
    `TRUNCATE featured_slots, click_events, link_checks, block_changes,
              occupied_tiles, blocks RESTART IDENTITY CASCADE`,
  );

  const userId = await showcaseUser(pool);

  // The anchors go down first, on an empty board, so they get the middle of
  // their orbit rather than whatever the random fill leaves behind.
  const anchors = await placeAnchors(pool, avatarDir, userId);

  // Then the ordinary seeder fills in around them. It claims through the real
  // transaction, so it simply routes around the anchors the way a real buyer
  // would: the tiles are taken and the primary key says so.
  const seeded = await seedBoard(pool, avatarDir, target);

  const auras = await spreadAuras(pool);
  await addDescriptions(pool);
  await varyClicks(pool);
  await breakAFewLinks(pool);

  invalidateCompositeBoard();

  return {
    blocks: seeded.blocks + anchors,
    tiles: seeded.tiles,
    anchors,
    auras,
  };
}

async function showcaseUser(pool: Pool): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO users (x_handle, x_user_id, display_name)
     VALUES ('showcase', 'showcase-user', 'Showcase')
     ON CONFLICT (x_user_id) DO UPDATE SET x_handle = EXCLUDED.x_handle
     RETURNING id`,
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error("could not create the showcase user");
  return row.id;
}

/**
 * One planet in each orbit, at exactly that orbit's maximum size.
 *
 * This is the thing a screenshot needs to show: the core takes a ten, the inner
 * belt takes a fifteen, the outer reach takes a six and no more. Three planets
 * make that rule visible in a way the price list does not.
 */
async function placeAnchors(pool: Pool, avatarDir: URL, userId: string): Promise<number> {
  const centre = 150;
  let placed = 0;

  for (const anchor of ANCHORS) {
    const orbit = ORBITS.find((candidate) => candidate.name === anchor.orbit);
    if (orbit === undefined) continue;

    const size = orbit.maxSize;
    // Just inside the ring, on the diagonal, so the three do not sit in a line
    // and none of them straddles a boundary into a stricter cap.
    const spot = spotInside(orbit.outerRadius, size, centre, placed);
    if (spot === null) continue;

    try {
      const block = await claimBlock(pool, userId, { ...spot, size });
      const initials = anchor.name
        .split(" ")
        .map((part) => part[0] ?? "")
        .join("");
      const avatar = await generateAvatar(anchor.handle, initials, avatarPixelsFor(size));
      await writeFile(new URL(`${block.id}.webp`, avatarDir), avatar);

      await pool.query(
        `UPDATE blocks
            SET status = 'live', reserved_until = NULL, published_at = now(),
                display_name = $2, handle = $3, image_url = $4,
                primary_url = $5, description = $6,
                category = $7::planet_category, aura = $8, click_count = $9,
                link_ok = true, link_checked_at = now()
          WHERE id = $1`,
        [
          block.id,
          anchor.name,
          anchor.handle,
          `/avatars/${block.id}.webp`,
          `https://example.com/${anchor.handle}`,
          anchor.description,
          anchor.category,
          anchor.aura,
          anchor.clicks,
        ],
      );
      placed += 1;
    } catch (error) {
      // Nothing else is on the board yet, so this should not happen. If it
      // does, the showcase is still worth having without this one planet.
      if (!(error instanceof TileConflictError)) throw error;
    }
  }

  return placed;
}

/**
 * A square that fits well inside a ring of this radius.
 *
 * Well inside rather than merely inside: a planet touching the boundary is
 * governed by the stricter of the two orbits it touches, which is exactly the
 * rule these anchors exist to illustrate, so they must not trip it.
 */
function spotInside(
  outerRadius: number,
  size: number,
  centre: number,
  index: number,
): { x: number; y: number } | null {
  const angle = (Math.PI / 4) * (1 + index * 2);
  const radius = Math.max(0, outerRadius - size * 1.6);

  const x = Math.round(centre + Math.cos(angle) * radius) - Math.floor(size / 2);
  const y = Math.round(centre + Math.sin(angle) * radius) - Math.floor(size / 2);
  if (x < 0 || y < 0) return null;
  return { x, y };
}

/**
 * Every aura, spread across the board.
 *
 * The seeder leaves them all on the default, so a seeded board is one colour
 * and the halos read as a rendering artefact rather than as a thing somebody
 * chose. Assigned by position rather than at random, so neighbouring planets
 * differ instead of clustering.
 */
async function spreadAuras(pool: Pool): Promise<number> {
  const names = AURAS.map((aura) => aura.name);

  const result = await pool.query(
    `UPDATE blocks
        SET aura = $1::text[][ (abs(hashtext(id::text)) % $2::int) + 1 ]
      WHERE status = 'live' AND handle NOT IN (SELECT unnest($3::text[]))`,
    [names, names.length, ANCHORS.map((anchor) => anchor.handle)],
  );
  return result.rowCount ?? 0;
}

/** Something for search to find, and something for a share card to say. */
async function addDescriptions(pool: Pool): Promise<void> {
  await pool.query(
    `UPDATE blocks
        SET description = $1::text[][ (abs(hashtext(handle)) % $2::int) + 1 ]
      WHERE status = 'live' AND description IS NULL`,
    [BLURBS, BLURBS.length],
  );
}

/**
 * Click counts with a shape.
 *
 * Heavily skewed, because real traffic is: a few planets get most of it, and a
 * board where every counter reads about the same tells you nothing about
 * whether the ordering works.
 */
async function varyClicks(pool: Pool): Promise<void> {
  await pool.query(
    `UPDATE blocks
        SET click_count = greatest(0,
              round((abs(hashtext(id::text)) % 1000) ^ 1.35 / 90.0)::int * size)
      WHERE status = 'live' AND click_count = 0`,
  );
}

/**
 * A few planets whose link has stopped answering.
 *
 * Three of them, past the threshold, so the warning on the hover card and the
 * /api/links/dead listing both have something real in them. Without this the
 * only way to see that feature is to wait for somebody's link to rot.
 */
async function breakAFewLinks(pool: Pool): Promise<void> {
  await pool.query(
    `UPDATE blocks
        SET link_ok = false, link_failures = 3, link_checked_at = now() - interval '2 hours'
      WHERE id IN (
        SELECT id FROM blocks
         WHERE status = 'live' AND handle NOT IN (SELECT unnest($1::text[]))
         ORDER BY hashtext(id::text)
         LIMIT 3
      )`,
    [ANCHORS.map((anchor) => anchor.handle)],
  );

  await pool.query(
    `UPDATE blocks
        SET link_ok = true, link_checked_at = now() - interval '3 hours'
      WHERE status = 'live' AND link_ok IS NULL`,
  );
}
