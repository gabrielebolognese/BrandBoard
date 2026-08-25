/**
 * Single source of truth for board dimensions.
 *
 * Nothing else in the codebase may hardcode 100. The SQL side mirrors these as
 * board_size() / max_block_size() in db/schema.sql; src/config.test.ts asserts
 * the two agree against a live database.
 */
export const BOARD_SIZE = 300;

export const MIN_BLOCK_SIZE = 1;

/**
 * Largest square anyone may buy, in tiles. The cap exists so no single buyer
 * can corner the sky. Below it, a planet may sit at any free (x, y) and the
 * only other rules are that it cannot overlap tiles someone already holds and
 * must fit inside the universe.
 */
export const MAX_BLOCK_SIZE = 25;

// ---------------------------------------------------------------------------
// Orbits
// ---------------------------------------------------------------------------

/**
 * The universe is a disc, not a square, and it is priced by how close to the
 * centre you are.
 *
 * Three orbits, charged per tile per month. The core is small and expensive,
 * the outer ring is vast and cheap, and the board's square extent exists only
 * because tiles are addressed by (x, y): everything outside UNIVERSE_RADIUS is
 * void and cannot be bought.
 */
export const UNIVERSE_RADIUS = 150;

/** Where the universe is centred, in tile coordinates. */
export const BOARD_CENTER = BOARD_SIZE / 2;

export interface Orbit {
  readonly name: string;
  readonly label: string;
  /** Everything closer than this, and no closer than the previous orbit. */
  readonly outerRadius: number;
  readonly centsPerTilePerMonth: number;
}

export const ORBITS: readonly Orbit[] = [
  { name: "core", label: "Core", outerRadius: 20, centsPerTilePerMonth: 500 },
  { name: "inner", label: "Inner belt", outerRadius: 60, centsPerTilePerMonth: 300 },
  { name: "outer", label: "Outer reach", outerRadius: UNIVERSE_RADIUS, centsPerTilePerMonth: 100 },
];

/** Distance from the centre of the universe to the centre of a tile. */
export function distanceFromCenter(x: number, y: number): number {
  const dx = x + 0.5 - BOARD_CENTER;
  const dy = y + 0.5 - BOARD_CENTER;
  return Math.sqrt(dx * dx + dy * dy);
}

/** The orbit a tile sits in, or null when it is outside the universe. */
export function orbitAt(x: number, y: number): Orbit | null {
  const distance = distanceFromCenter(x, y);
  for (const orbit of ORBITS) {
    if (distance < orbit.outerRadius) return orbit;
  }
  return null;
}

/**
 * What a planet costs each month: the sum of its tiles, each at the rate of the
 * orbit it falls in.
 *
 * Summed per tile rather than taken from the planet's centre, because a planet
 * spanning two orbits genuinely occupies expensive ground and cheap ground, and
 * charging for the average of the two would let someone straddle the core at a
 * discount.
 */
export function monthlyPriceCents(x: number, y: number, size: number): number {
  let cents = 0;
  for (let dx = 0; dx < size; dx += 1) {
    for (let dy = 0; dy < size; dy += 1) {
      cents += orbitAt(x + dx, y + dy)?.centsPerTilePerMonth ?? 0;
    }
  }
  return cents;
}

/**
 * Whether a planet fits inside the universe.
 *
 * The far corner is what decides it: a square is inside the disc only when its
 * furthest corner from the centre is.
 */
export function fitsInUniverse(x: number, y: number, size: number): boolean {
  const corners = [
    [x, y],
    [x + size, y],
    [x, y + size],
    [x + size, y + size],
  ];
  let furthest = 0;
  for (const [cx, cy] of corners) {
    const dx = (cx ?? 0) - BOARD_CENTER;
    const dy = (cy ?? 0) - BOARD_CENTER;
    furthest = Math.max(furthest, Math.sqrt(dx * dx + dy * dy));
  }
  return furthest <= UNIVERSE_RADIUS;
}

export const TILE_COUNT = BOARD_SIZE * BOARD_SIZE;

/** How long a claim holds its tiles before payment. */
export const RESERVATION_TTL_MINUTES = 15;

/**
 * How long a block keeps its square after the period it paid for has ended.
 *
 * A card expiring should not cost someone their spot the same hour, and payment
 * providers retry failed charges for days. Nothing is released until the paid
 * period ended this long ago.
 */
export const SUBSCRIPTION_GRACE_DAYS = 3;

/**
 * Board pixels per tile, and the gap around each tile.
 *
 * BOARD_SIZE * TILE_PIXELS = 3600px composite. Twelve rather than twenty four
 * because the universe is now three hundred tiles across: at the old pitch the
 * image would be 7200px square, which is past what is worth rendering or
 * sending.
 */
export const TILE_PIXELS = 12;
export const TILE_INSET = 1;

/** Diameter of the planet drawn for a single tile: 12 - 1 - 1 = 10px. */
export const TILE_SQUARE = TILE_PIXELS - 2 * TILE_INSET;

/** Planets are rented, not bought outright: every rate is per tile per month. */
export const BILLING_PERIOD = "month" as const;

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
