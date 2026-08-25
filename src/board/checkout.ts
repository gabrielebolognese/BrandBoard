import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { BILLING_PERIOD, RESERVATION_TTL_MINUTES, monthlyPriceCents, orbitAt } from "../config.js";
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
 * A price is never taken from the client. The client sends where and how big,
 * and the money is derived here from the orbits those tiles fall in.
 */

export interface CheckoutLine {
  readonly blockId: string;
  readonly x: number;
  readonly y: number;
  readonly size: number;
  readonly tiles: number;
  readonly monthlyCents: number;
  /** The orbit the planet's centre sits in, for showing what was charged. */
  readonly orbit: string;
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
  /** When the reservation lapses and the tiles go back on sale. */
  readonly expiresAt: Date;
}

export interface CheckoutOptions {
  readonly reservationMinutes?: number;
}

export async function createCheckout(
  pool: Pool,
  userId: string,
  placements: readonly Placement[],
  options: CheckoutOptions = {},
): Promise<Checkout> {
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
    const middle = Math.floor(block.size / 2);
    return {
      blockId: block.id,
      x: block.x,
      y: block.y,
      size: block.size,
      tiles: block.size * block.size,
      monthlyCents: monthlyPriceCents(block.x, block.y, block.size),
      orbit: orbitAt(block.x + middle, block.y + middle)?.label ?? "Void",
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
    expiresAt,
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
