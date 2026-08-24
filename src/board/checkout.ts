import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { BILLING_PERIOD, RESERVATION_TTL_MINUTES } from "../config.js";
import { claimBlocks } from "./claim.js";
import type { Placement } from "./geometry.js";

/**
 * Turning a cart into a payable checkout.
 *
 * Two things happen here and the order matters: the blocks are reserved first,
 * atomically, and only then is a price computed. A checkout that quoted a price
 * for tiles it had not secured would be quoting for squares someone else could
 * take before payment lands.
 *
 * The rate is passed in rather than read from config, so the caller has to be
 * explicit about where the number came from. A price is never taken from the
 * client: `size` is, and the money is derived from it here.
 */

export interface CheckoutLine {
  readonly blockId: string;
  readonly x: number;
  readonly y: number;
  readonly size: number;
  readonly tiles: number;
  readonly monthlyCents: number;
}

export interface Checkout {
  readonly id: string;
  readonly provider: "paddle";
  /** False until the payment provider is actually wired up. */
  readonly ready: boolean;
  readonly currency: "USD";
  readonly billingPeriod: typeof BILLING_PERIOD;
  readonly lines: CheckoutLine[];
  readonly tiles: number;
  readonly monthlyTotalCents: number;
  readonly rateCentsPerTilePerMonth: number;
  /** When the reservation lapses and the tiles go back on sale. */
  readonly expiresAt: Date;
}

export interface CheckoutOptions {
  /** True when the rate is a dev stand-in rather than a decided price. */
  readonly rateIsPlaceholder?: boolean;
  readonly reservationMinutes?: number;
}

export async function createCheckout(
  pool: Pool,
  userId: string,
  placements: readonly Placement[],
  rateCentsPerTilePerMonth: number,
  options: CheckoutOptions = {},
): Promise<Checkout & { rateIsPlaceholder: boolean }> {
  if (!Number.isInteger(rateCentsPerTilePerMonth) || rateCentsPerTilePerMonth <= 0) {
    throw new Error("The per-tile monthly rate must be a positive integer number of cents.");
  }

  const id = `chk_${randomUUID()}`;

  // Reserve everything or nothing. A conflict throws TileConflictError straight
  // through to the caller, which is what puts a 409 on the wire.
  const blocks = await claimBlocks(pool, userId, placements, {
    checkoutSessionId: id,
    ...(options.reservationMinutes === undefined
      ? {}
      : { reservationMinutes: options.reservationMinutes }),
  });

  const lines: CheckoutLine[] = blocks.map((block) => {
    const tiles = block.size * block.size;
    return {
      blockId: block.id,
      x: block.x,
      y: block.y,
      size: block.size,
      tiles,
      monthlyCents: tiles * rateCentsPerTilePerMonth,
    };
  });

  const tiles = lines.reduce((sum, line) => sum + line.tiles, 0);
  const expiresAt =
    blocks[0]?.reservedUntil ??
    new Date(Date.now() + (options.reservationMinutes ?? RESERVATION_TTL_MINUTES) * 60_000);

  return {
    id,
    provider: "paddle",
    // Flipped on once Paddle is connected and this returns a real pay link.
    ready: false,
    currency: "USD",
    billingPeriod: BILLING_PERIOD,
    lines,
    tiles,
    monthlyTotalCents: lines.reduce((sum, line) => sum + line.monthlyCents, 0),
    rateCentsPerTilePerMonth,
    expiresAt,
    rateIsPlaceholder: options.rateIsPlaceholder === true,
  };
}

/**
 * The blocks belonging to a checkout, for reloading the terminal after a
 * refresh. Reads back from the database rather than trusting anything held in
 * the page.
 */
export async function readCheckout(
  pool: Pool,
  checkoutId: string,
): Promise<Array<{ id: string; x: number; y: number; size: number; status: string; reservedUntil: Date | null }>> {
  const result = await pool.query<{
    id: string;
    x: number;
    y: number;
    size: number;
    status: string;
    reserved_until: Date | null;
  }>(
    `SELECT id, x, y, size, status, reserved_until
       FROM blocks
      WHERE checkout_session_id = $1
      ORDER BY x, y`,
    [checkoutId],
  );

  return result.rows.map((row) => ({
    id: row.id,
    x: row.x,
    y: row.y,
    size: row.size,
    status: row.status,
    reservedUntil: row.reserved_until,
  }));
}
