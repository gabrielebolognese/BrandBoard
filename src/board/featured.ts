import type { Pool } from "pg";
import { FEATURED_SLOTS, featuredPriceCents, isValidFeaturedDays } from "../config.js";
import type { Queryable } from "../db/client.js";

/**
 * Featured slots.
 *
 * Every purchase runs its own clock. Buying a day of featuring at noon expires
 * at noon tomorrow; buying another at five gets its own full day and expires at
 * five, with the first still running its remaining nineteen hours. There is no
 * shared daily reset anywhere in here, and there should not be one: the window
 * is `starts_at` to `expires_at` on the row, and nothing else decides it.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface FeaturedBlock {
  readonly slotId: string;
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly size: number;
  readonly name: string;
  readonly handle: string;
  readonly url: string;
  readonly expiresAt: Date;
  readonly secondsRemaining: number;
}

export class UnknownBlockError extends Error {
  readonly code = "unknown_block";
  readonly status = 404;

  constructor(readonly blockId: string) {
    super("No such block.");
    this.name = "UnknownBlockError";
  }
}

export class BlockNotLiveError extends Error {
  readonly code = "block_not_live";
  readonly status = 409;

  constructor(readonly status_: string) {
    super(`Only a live block can be featured; this one is ${status_}.`);
    this.name = "BlockNotLiveError";
  }
}

export class InvalidFeaturedDaysError extends Error {
  readonly code = "invalid_featured_days";
  readonly status = 400;

  constructor(readonly days: number) {
    super(`Featuring runs from 1 to 10 days; ${days} is not one of them.`);
    this.name = "InvalidFeaturedDaysError";
  }
}

/**
 * Buys a featured window for a block, starting now.
 *
 * The price is computed here from the day count. It is never accepted from the
 * caller, for the same reason tile prices are not.
 */
export async function featureBlock(
  db: Queryable,
  blockId: string,
  days: number,
  checkoutSessionId: string | null = null,
): Promise<{ slotId: string; expiresAt: Date; priceCents: number }> {
  if (!isValidFeaturedDays(days)) throw new InvalidFeaturedDaysError(days);
  const priceCents = featuredPriceCents(days);

  // Featuring something that is not on the board would take money for a slot
  // activeFeatured() filters out, so it would be paid for and never shown.
  if (!UUID.test(blockId)) throw new UnknownBlockError(blockId);
  const target = await db.query<{ status: string }>(`SELECT status FROM blocks WHERE id = $1`, [
    blockId,
  ]);
  const status = target.rows[0]?.status;
  if (status === undefined) throw new UnknownBlockError(blockId);
  if (status !== "live") throw new BlockNotLiveError(status);

  const result = await db.query<{ id: string; expires_at: Date }>(
    `INSERT INTO featured_slots (block_id, days, price_cents, checkout_session_id,
                                 starts_at, expires_at)
     VALUES ($1, $2::int, $3, $4, now(), now() + make_interval(days => $2::int))
     RETURNING id, expires_at`,
    [blockId, days, priceCents, checkoutSessionId],
  );

  const row = result.rows[0];
  if (row === undefined) throw new Error("featured slot insert returned no row");
  return { slotId: row.id, expiresAt: row.expires_at, priceCents };
}

/**
 * What is featured at this instant, newest purchase first.
 *
 * Expiry is a read-time filter rather than a scheduled job: a slot is featured
 * while now() is inside its window, so nothing has to run for one to stop
 * appearing the moment it lapses.
 */
export async function activeFeatured(pool: Pool, limit = FEATURED_SLOTS): Promise<FeaturedBlock[]> {
  const result = await pool.query<{
    slot_id: string;
    id: string;
    x: number;
    y: number;
    size: number;
    name: string;
    handle: string;
    url: string;
    expires_at: Date;
    seconds_remaining: string;
  }>(
    `SELECT f.id AS slot_id,
            b.id, b.x, b.y, b.size,
            b.display_name AS name, b.handle, b.primary_url AS url,
            f.expires_at,
            extract(epoch FROM (f.expires_at - now()))::bigint AS seconds_remaining
       FROM featured_slots f
       JOIN blocks b ON b.id = f.block_id
      WHERE f.starts_at <= now()
        AND f.expires_at > now()
        AND b.status = 'live'
      ORDER BY f.starts_at DESC
      LIMIT $1`,
    [limit],
  );

  return result.rows.map((row) => ({
    slotId: row.slot_id,
    id: row.id,
    x: row.x,
    y: row.y,
    size: row.size,
    name: row.name,
    handle: row.handle,
    url: row.url,
    expiresAt: row.expires_at,
    secondsRemaining: Number(row.seconds_remaining),
  }));
}

/** Every featured window a block has had, newest first. */
export async function featuredHistory(
  pool: Pool,
  blockId: string,
): Promise<Array<{ slotId: string; days: number; priceCents: number; startsAt: Date; expiresAt: Date }>> {
  const result = await pool.query<{
    id: string;
    days: number;
    price_cents: number;
    starts_at: Date;
    expires_at: Date;
  }>(
    `SELECT id, days, price_cents, starts_at, expires_at
       FROM featured_slots
      WHERE block_id = $1
      ORDER BY starts_at DESC`,
    [blockId],
  );

  return result.rows.map((row) => ({
    slotId: row.id,
    days: row.days,
    priceCents: row.price_cents,
    startsAt: row.starts_at,
    expiresAt: row.expires_at,
  }));
}
