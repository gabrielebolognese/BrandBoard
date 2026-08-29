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
 * The largest square any orbit allows. Each orbit has its own, stricter limit
 * below; this is only the ceiling none of them exceeds.
 */
export const MAX_BLOCK_SIZE = 15;

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
  /** The largest planet this orbit will take. */
  readonly maxSize: number;
}

/**
 * Size is capped per orbit, and the caps do not follow the price.
 *
 * The outer reach is the cheapest ground, so without a limit the rational move
 * is to buy an enormous cheap planet out there and dominate the sky for very
 * little. Six is small enough that the outer reach stays what it is meant to
 * be: a lot of room for a lot of people. The inner belt takes the biggest
 * planets because that is the ground worth showing off on, and the core is kept
 * moderate so a single buyer cannot swallow the middle of the universe.
 */
export const ORBITS: readonly Orbit[] = [
  { name: "core", label: "Core", outerRadius: 20, centsPerTilePerMonth: 500, maxSize: 10 },
  { name: "inner", label: "Inner belt", outerRadius: 60, centsPerTilePerMonth: 300, maxSize: 15 },
  {
    name: "outer",
    label: "Outer reach",
    outerRadius: UNIVERSE_RADIUS,
    centsPerTilePerMonth: 100,
    maxSize: 6,
  },
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

/** Nearest and furthest a square gets from the centre of the universe. */
function distanceRange(x: number, y: number, size: number): { min: number; max: number } {
  const dx = Math.max(x - BOARD_CENTER, 0, BOARD_CENTER - (x + size));
  const dy = Math.max(y - BOARD_CENTER, 0, BOARD_CENTER - (y + size));
  const min = Math.sqrt(dx * dx + dy * dy);

  let max = 0;
  for (const [cx, cy] of [
    [x, y],
    [x + size, y],
    [x, y + size],
    [x + size, y + size],
  ]) {
    const ex = (cx ?? 0) - BOARD_CENTER;
    const ey = (cy ?? 0) - BOARD_CENTER;
    max = Math.max(max, Math.sqrt(ex * ex + ey * ey));
  }
  return { min, max };
}

/**
 * The largest planet allowed where this one sits: the strictest cap among every
 * orbit it touches.
 *
 * Strictest, not the cap of whichever orbit its centre happens to fall in.
 * Otherwise a planet could be centred just inside the inner belt and sprawl out
 * into the outer reach at fifteen wide, which is the exact thing the outer
 * reach's limit exists to prevent.
 */
export function sizeCapAt(x: number, y: number, size: number): number {
  const { min, max } = distanceRange(x, y, size);
  let cap = MAX_BLOCK_SIZE;
  let inner = 0;

  for (const orbit of ORBITS) {
    const touches = max > inner && min < orbit.outerRadius;
    if (touches) cap = Math.min(cap, orbit.maxSize);
    inner = orbit.outerRadius;
  }
  return cap;
}

/** Whether a planet of this size is allowed to sit here. */
export function isSizeAllowedAt(x: number, y: number, size: number): boolean {
  return size <= sizeCapAt(x, y, size);
}

/** The biggest planet that will actually be accepted at this anchor. */
export function largestAllowedAt(x: number, y: number, wanted: number): number {
  for (let size = Math.min(wanted, MAX_BLOCK_SIZE); size >= 1; size -= 1) {
    if (fitsInUniverse(x, y, size) && isSizeAllowedAt(x, y, size)) return size;
  }
  return 0;
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

/**
 * Rates are quoted per tile per month, and charged a year at a time.
 *
 * Monthly billing does not survive contact with the outer reach. A one tile
 * planet there is a dollar a month, and card processing on a dollar costs
 * between a third and a half of it, every month, forever. A year in one
 * transaction turns that into a few percent, and it suits a product where you
 * are buying a place in a universe rather than renting a desk.
 */
export const BILLING_INTERVAL = "year" as const;
export const MONTHS_PER_TERM = 12;

/**
 * The smallest monthly rate an order can be charged at.
 *
 * The same arithmetic from the other end: even annually, a dollar a month is
 * twelve dollars a year, and the fee on that is still meaningful. Orders below
 * the floor are charged the floor, which is stated before anyone commits, so
 * the smallest planets stay buyable rather than being refused at checkout.
 */
export const MONTHLY_FLOOR_CENTS = 500;

export interface OrderTotals {
  /** What the tiles come to, before the floor. */
  readonly monthlySubtotalCents: number;
  /** What is actually charged per month of the term. */
  readonly monthlyTotalCents: number;
  /** The one figure that leaves the account. */
  readonly termTotalCents: number;
  readonly floorApplied: boolean;
  readonly months: number;
  readonly interval: typeof BILLING_INTERVAL;
}

export function orderTotals(monthlyCentsPerLine: readonly number[]): OrderTotals {
  const monthlySubtotalCents = monthlyCentsPerLine.reduce((sum, cents) => sum + cents, 0);
  const monthlyTotalCents = Math.max(monthlySubtotalCents, MONTHLY_FLOOR_CENTS);

  return {
    monthlySubtotalCents,
    monthlyTotalCents,
    termTotalCents: monthlyTotalCents * MONTHS_PER_TERM,
    floorApplied: monthlyTotalCents > monthlySubtotalCents,
    months: MONTHS_PER_TERM,
    interval: BILLING_INTERVAL,
  };
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

// ---------------------------------------------------------------------------
// Auras
// ---------------------------------------------------------------------------

/**
 * The halo a planet sits in. A fixed set rather than a free colour, so the sky
 * stays coherent and nothing user-supplied is rendered as a colour value.
 */
export interface Aura {
  readonly name: string;
  readonly label: string;
  readonly rgb: string;
}

export const AURAS: readonly Aura[] = [
  { name: "violet", label: "Violet", rgb: "168, 85, 247" },
  { name: "azure", label: "Azure", rgb: "96, 165, 250" },
  { name: "cyan", label: "Cyan", rgb: "34, 211, 238" },
  { name: "emerald", label: "Emerald", rgb: "52, 211, 153" },
  { name: "amber", label: "Amber", rgb: "251, 191, 36" },
  { name: "rose", label: "Rose", rgb: "244, 114, 182" },
  { name: "pearl", label: "Pearl", rgb: "226, 234, 250" },
];

export const DEFAULT_AURA = "azure";

export function isKnownAura(name: unknown): name is string {
  return typeof name === "string" && AURAS.some((aura) => aura.name === name);
}

// ---------------------------------------------------------------------------
// Trials
// ---------------------------------------------------------------------------

/** Long enough to see whether anyone clicks, short enough not to be free rent. */
export const TRIAL_DAYS = 3;

// ---------------------------------------------------------------------------
// Reach
// ---------------------------------------------------------------------------

/**
 * A projection of how often a planet gets clicked, shown at checkout.
 *
 * This is a model, not a measurement, and it is labelled as one everywhere it
 * appears. It scales with the two things that actually decide whether a planet
 * is noticed: how big it is on screen, and how close it is to the centre, which
 * is where every visitor starts.
 *
 * Once clicks are recorded for real, this should be replaced by the observed
 * rate for planets of a similar size and orbit. Until then it must never be
 * presented as a promise.
 */
const BASE_CLICK_RATE = 0.012;

const ORBIT_ATTENTION: Record<string, number> = {
  core: 1,
  inner: 0.55,
  outer: 0.25,
};

export interface ReachEstimate {
  readonly low: number;
  readonly high: number;
  readonly basis: string;
}

export function estimatedMonthlyClicks(
  x: number,
  y: number,
  size: number,
  dailyVisitors: number,
): ReachEstimate {
  const middle = Math.floor(size / 2);
  const orbit = orbitAt(x + middle, y + middle);
  const attention = ORBIT_ATTENTION[orbit?.name ?? "outer"] ?? ORBIT_ATTENTION["outer"] ?? 0.25;

  // Screen presence grows with the side of the planet, not its area: a 4x4 is
  // four times as noticeable as a 1x1, not sixteen.
  const centre = dailyVisitors * 30 * BASE_CLICK_RATE * attention * size;

  return {
    low: Math.max(0, Math.round(centre * 0.65)),
    high: Math.round(centre * 1.35),
    basis: `${dailyVisitors.toLocaleString()} visitors a day, ${orbit?.label ?? "the void"}`,
  };
}
