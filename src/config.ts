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
 * There is no purchasable-size list and no maximum block size. A block may be
 * any N x N square, up to the whole board, and the only thing that can stop it
 * is a tile someone else already holds. The board's own edge is therefore the
 * only ceiling: a block is legal when x + size and y + size both fit.
 */
export const MAX_BLOCK_SIZE = BOARD_SIZE;

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

/**
 * Flat rate per tile, in minor currency units. Deliberately has no default:
 * the price is a business decision that has not been made yet, and a silent
 * fallback would ship the wrong number to a real checkout.
 */
export function pricePerTileCents(): number {
  const raw = process.env["PRICE_PER_TILE_CENTS"];
  const value = Number(raw);
  if (raw === undefined || raw === "" || !Number.isInteger(value) || value <= 0) {
    throw new Error(
      "PRICE_PER_TILE_CENTS must be set to a positive integer number of cents per tile.",
    );
  }
  return value;
}

/**
 * The only place a checkout price may come from. Derived from size on the
 * server; a price supplied by the client is never read.
 */
export function priceForSizeCents(size: number): number {
  return size * size * pricePerTileCents();
}
