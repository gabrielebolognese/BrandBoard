import { createHash } from "node:crypto";
import type { Pool } from "pg";

/**
 * Click recording.
 *
 * The table has existed since the first migration and nothing ever wrote to it,
 * which meant `click_count` was always zero and the click estimate shown at
 * checkout was a guess with nothing behind it. This is what makes it a number.
 *
 * It matters more than a counter usually would: the whole pitch for renting a
 * planet rather than buying a pixel is that the traffic is measurable and the
 * board stays alive. An owner who can see clicks renews; one who cannot, does
 * not.
 */

/** Truncated: a full digest is 32 bytes per click per day and buys nothing. */
const HASH_BYTES = 16;

/**
 * Visitors are counted once per planet per day, so the same person reloading a
 * planet does not inflate anyone's numbers. That needs a stable identifier, and
 * an IP address is the only one available without asking the visitor for
 * anything, so it is salted and hashed rather than stored.
 *
 * The day goes into the digest as well as the row. A hash that is the same
 * every day can be followed across days; one that changes cannot, and the
 * unique constraint still works because the date is its own column.
 */
export function hashVisitor(ip: string, day: Date = new Date()): Buffer {
  const salt = process.env["CLICK_SALT"] ?? "brandspace-development-salt";
  const date = day.toISOString().slice(0, 10);
  return createHash("sha256").update(`${salt}:${date}:${ip}`).digest().subarray(0, HASH_BYTES);
}

export interface ClickOutcome {
  /** Where to send the visitor, or null if this planet has nowhere to send them. */
  readonly url: string | null;
  /** False when this visitor already counted today. The redirect still happens. */
  readonly counted: boolean;
}

/**
 * Records a click and says where the visitor goes.
 *
 * One statement, so the event and the counter cannot disagree: if the insert is
 * refused by the per-day unique constraint, the update never runs. Doing it as
 * two statements would let a crash in between leave a click recorded but
 * uncounted, and the counter is what owners look at.
 *
 * Only live planets resolve. A reserved or lapsed one returns no URL rather
 * than an error, because these links are public and end up in places that
 * outlive the planet.
 */
export async function recordClick(pool: Pool, blockId: string, ip: string): Promise<ClickOutcome> {
  const result = await pool.query<{ primary_url: string; counted: boolean }>(
    `WITH target AS (
       SELECT id, primary_url FROM blocks
        WHERE id = $1 AND status = 'live' AND primary_url IS NOT NULL
     ), inserted AS (
       INSERT INTO click_events (block_id, ip_hash)
       SELECT id, $2 FROM target
       ON CONFLICT (block_id, day, ip_hash) DO NOTHING
       RETURNING block_id
     ), bumped AS (
       UPDATE blocks SET click_count = click_count + 1
        WHERE id IN (SELECT block_id FROM inserted)
       RETURNING id
     )
     SELECT target.primary_url, (SELECT count(*) FROM bumped) > 0 AS counted
       FROM target`,
    [blockId, hashVisitor(ip)],
  );

  const row = result.rows[0];
  if (row === undefined) return { url: null, counted: false };
  return { url: row.primary_url, counted: row.counted };
}

export interface ClickDay {
  readonly day: string;
  readonly clicks: number;
}

export interface ClickSummary {
  readonly total: number;
  readonly last7: number;
  readonly last30: number;
  readonly daily: ClickDay[];
}

/**
 * What an owner sees on their dashboard.
 *
 * Days with no clicks are filled in rather than skipped, so a chart drawn from
 * this does not silently close the gaps and turn a quiet week into a flat line
 * at the wrong height.
 */
export async function clickSummary(pool: Pool, blockId: string, days = 30): Promise<ClickSummary> {
  const span = Math.max(1, Math.min(365, Math.trunc(days)));

  const result = await pool.query<{ day: string; clicks: string }>(
    `SELECT to_char(d.day, 'YYYY-MM-DD') AS day, count(c.id)::text AS clicks
       FROM generate_series(current_date - ($2::int - 1), current_date, '1 day') AS d(day)
       LEFT JOIN click_events c ON c.block_id = $1 AND c.day = d.day
      GROUP BY d.day
      ORDER BY d.day`,
    [blockId, span],
  );

  const daily = result.rows.map((row) => ({ day: row.day, clicks: Number(row.clicks) }));

  const totals = await pool.query<{ total: string; last7: string; last30: string }>(
    `SELECT count(*)::text AS total,
            count(*) FILTER (WHERE day > current_date - 7)::text  AS last7,
            count(*) FILTER (WHERE day > current_date - 30)::text AS last30
       FROM click_events WHERE block_id = $1`,
    [blockId],
  );

  const row = totals.rows[0];
  return {
    total: Number(row?.total ?? 0),
    last7: Number(row?.last7 ?? 0),
    last30: Number(row?.last30 ?? 0),
    daily,
  };
}

/**
 * The board-wide number, for the landing page.
 *
 * Counted from click_events rather than summed from click_count, because the
 * counter survives a block being taken down and the events do not.
 */
export async function totalClicks(pool: Pool, sinceDays = 30): Promise<number> {
  const result = await pool.query<{ count: string }>(
    `SELECT count(*)::text FROM click_events WHERE day > current_date - $1::int`,
    [Math.max(1, Math.trunc(sinceDays))],
  );
  return Number(result.rows[0]?.count ?? 0);
}
