/**
 * Single source of truth for board dimensions.
 *
 * Nothing else in the codebase may hardcode 100. The SQL side mirrors these as
 * board_size() / max_block_size() in db/schema.sql; src/config.test.ts asserts
 * the two agree against a live database.
 */
export const BOARD_SIZE = 100;

export const MIN_BLOCK_SIZE = 1;

/**
 * Largest square anyone may buy, in tiles. A 25x25 is 625 tiles, 6.25% of the
 * board; the cap exists so no single buyer can corner the board. Below it, a
 * block may sit at any free (x, y) and the only other rule is that it cannot
 * overlap tiles someone already holds.
 */
export const MAX_BLOCK_SIZE = 25;

export const TILE_COUNT = BOARD_SIZE * BOARD_SIZE;

/** How long a claim holds its tiles before payment. */
export const RESERVATION_TTL_MINUTES = 15;

/**
 * Board pixels per tile, and the gap around each tile's square.
 *
 * A tile is drawn as a 20px square with a 1px border, with TILE_INSET of empty
 * ground on every side, so neighbouring squares sit 2 * TILE_INSET apart and
 * the grid reads as discrete cells rather than a hairline mesh.
 * BOARD_SIZE * TILE_PIXELS = 2400px composite.
 */
export const TILE_PIXELS = 24;
export const TILE_INSET = 2;

/** Side of the square actually drawn for a single tile: 24 - 2 - 2 = 20px. */
export const TILE_SQUARE = TILE_PIXELS - 2 * TILE_INSET;

/** Blocks are rented, not bought outright: the rate is per tile per month. */
export const BILLING_PERIOD = "month" as const;

/**
 * Flat rate per tile per month, in minor currency units. Deliberately has no
 * default: the price is a business decision that has not been made yet, and a
 * silent fallback would ship the wrong number to a real checkout.
 */
export function pricePerTileCentsPerMonth(): number {
  const raw = process.env["PRICE_PER_TILE_CENTS_PER_MONTH"];
  const value = Number(raw);
  if (raw === undefined || raw === "" || !Number.isInteger(value) || value <= 0) {
    throw new Error(
      "PRICE_PER_TILE_CENTS_PER_MONTH must be set to a positive integer number of " +
        "cents, charged per tile per month.",
    );
  }
  return value;
}

/**
 * The recurring monthly charge for one block. The only place a checkout price
 * may come from: derived from size on the server, never read from the client.
 */
export function monthlyPriceCents(size: number): number {
  return size * size * pricePerTileCentsPerMonth();
}

// ---------------------------------------------------------------------------
// Featured slots
// ---------------------------------------------------------------------------

/**
 * Featuring is bought per block, in whole days, and each purchase runs its own
 * clock from the moment it is bought. There is no shared daily reset: a slot
 * bought at noon expires at noon, whatever anyone else bought and when.
 */
export const FEATURED_MIN_DAYS = 1;
export const FEATURED_MAX_DAYS = 10;

/** The first day costs more than the ones after it. */
export const FEATURED_FIRST_DAY_CENTS = 1000;
export const FEATURED_ADDITIONAL_DAY_CENTS = 800;

/** How many featured blocks the board shows at once. */
export const FEATURED_SLOTS = 5;

export function isValidFeaturedDays(days: number): boolean {
  return Number.isInteger(days) && days >= FEATURED_MIN_DAYS && days <= FEATURED_MAX_DAYS;
}

/**
 * $10 for the first day and $8 for every additional one, so 3 days is
 * 1000 + 2 * 800 = 2600, and the 10 day maximum is 8200.
 *
 * A one-off charge, unlike tile rent, which recurs monthly.
 */
export function featuredPriceCents(days: number): number {
  if (!isValidFeaturedDays(days)) {
    throw new Error(
      `Featured runs from ${FEATURED_MIN_DAYS} to ${FEATURED_MAX_DAYS} days; got ${days}.`,
    );
  }
  return FEATURED_FIRST_DAY_CENTS + (days - 1) * FEATURED_ADDITIONAL_DAY_CENTS;
}
