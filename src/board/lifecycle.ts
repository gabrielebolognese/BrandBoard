import type { Pool } from "pg";
import { SUBSCRIPTION_GRACE_DAYS, monthlyPriceCents } from "../config.js";
import { withTransaction } from "../db/client.js";
import type { Queryable } from "../db/client.js";
import { recordRefund } from "../payments/fulfilment.js";

/**
 * What happens to a block after it is paid for: approved onto the board,
 * rejected off it, or released when the rent stops.
 *
 * Every path that takes a block off the board does the same two things in one
 * transaction: change its status and delete its occupied_tiles rows. Tiles that
 * outlive the block holding them are the one way this product can end up with
 * squares nobody can buy and nobody owns.
 */

export interface BlockChange {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly size: number;
  readonly tilesReleased: number;
}

export type ApprovalRefusal = "not_in_review" | "incomplete_listing";

/**
 * Puts an approved listing on the board. The composite picks it up on the next
 * read, because the board version changes with the count of live blocks.
 *
 * A block with nothing to render cannot go live: blocks_live_requires_content
 * refuses it at the database, and this checks first so an admin gets an answer
 * rather than a constraint violation. The listing setup step is what fills
 * those fields in, and review comes after it.
 */
export async function approveBlock(
  pool: Pool,
  blockId: string,
): Promise<{ published: boolean; reason?: ApprovalRefusal }> {
  return withTransaction(pool, async (tx) => {
    const found = await tx.query<{
      status: string;
      image_url: string | null;
      display_name: string | null;
      handle: string | null;
      primary_url: string | null;
    }>(
      `SELECT status, image_url, display_name, handle, primary_url
         FROM blocks
        WHERE id = $1
        FOR UPDATE`,
      [blockId],
    );

    const block = found.rows[0];
    if (block === undefined || block.status !== "pending_review") {
      return { published: false, reason: "not_in_review" as const };
    }
    if (
      block.image_url === null ||
      block.display_name === null ||
      block.handle === null ||
      block.primary_url === null
    ) {
      return { published: false, reason: "incomplete_listing" as const };
    }

    await tx.query(
      `UPDATE blocks
          SET status = 'live', published_at = now(), reserved_until = NULL
        WHERE id = $1`,
      [blockId],
    );
    return { published: true };
  });
}

/**
 * Turns a listing down. Frees the square immediately and books the refund,
 * because the money was taken at checkout and the review happened afterwards.
 */
export async function rejectBlock(
  pool: Pool,
  blockId: string,
): Promise<{ rejected: boolean; tilesReleased: number; refundCents: number }> {
  return withTransaction(pool, async (tx) => {
    const found = await tx.query<{
      id: string;
      x: number;
      y: number;
      size: number;
      status: string;
      checkout_session_id: string | null;
    }>(
      `SELECT id, x, y, size, status, checkout_session_id
         FROM blocks
        WHERE id = $1
        FOR UPDATE`,
      [blockId],
    );

    const block = found.rows[0];
    if (block === undefined || (block.status !== "pending_review" && block.status !== "live")) {
      return { rejected: false, tilesReleased: 0, refundCents: 0 };
    }

    await tx.query(`UPDATE blocks SET status = 'rejected', published_at = NULL WHERE id = $1`, [
      blockId,
    ]);
    const released = await releaseTiles(tx, [blockId]);

    const refundCents = monthlyPriceCents(block.x, block.y, block.size);
    await recordRefund(tx, {
      blockId,
      checkoutId: block.checkout_session_id,
      reason: "rejected_in_review",
      amountCents: refundCents,
    });

    return { rejected: true, tilesReleased: released, refundCents };
  });
}

/**
 * Ends every block a subscription was paying for, when the provider says the
 * subscription is over.
 *
 * No refund by default: a cancellation normally means the buyer keeps what they
 * already paid for until the period ends, and this is called when it has. Pass
 * refundRemainder only for a policy that gives money back mid-period.
 */
export async function lapseSubscription(
  pool: Pool,
  subscriptionId: string,
  options: { refundRemainder?: boolean } = {},
): Promise<{ blocks: BlockChange[]; tilesReleased: number; refundCents: number }> {
  return withTransaction(pool, async (tx) => {
    const found = await tx.query<{ id: string; x: number; y: number; size: number; checkout_session_id: string | null }>(
      `SELECT id, x, y, size, checkout_session_id
         FROM blocks
        WHERE subscription_id = $1
          AND status IN ('live', 'pending_review')
        FOR UPDATE`,
      [subscriptionId],
    );

    if (found.rows.length === 0) return { blocks: [], tilesReleased: 0, refundCents: 0 };

    const ids = found.rows.map((row) => row.id);
    await tx.query(
      `UPDATE blocks SET status = 'expired', published_at = NULL WHERE id = ANY($1::uuid[])`,
      [ids],
    );
    const released = await releaseTiles(tx, ids);

    let refundCents = 0;
    if (options.refundRemainder === true) {
      for (const row of found.rows) {
        const amount = monthlyPriceCents(row.x, row.y, row.size);
        refundCents += amount;
        await recordRefund(tx, {
          blockId: row.id,
          checkoutId: row.checkout_session_id,
          reason: "subscription_lapsed",
          amountCents: amount,
        });
      }
    }

    return {
      blocks: found.rows.map((row) => ({
        id: row.id,
        x: row.x,
        y: row.y,
        size: row.size,
        tilesReleased: row.size * row.size,
      })),
      tilesReleased: released,
      refundCents,
    };
  });
}

/**
 * The scheduled half of subscription expiry, and the reason an unpaid block
 * cannot sit on the board forever.
 *
 * Webhooks are the fast path, but they can be missed, delayed, or arrive for an
 * event we do not handle. This sweeps on the state we control instead: a planet
 * whose paid period ended more than the grace period ago, or whose free trial
 * has simply run out, is released whatever the provider did or did not say.
 *
 * Same shape as the reservation sweep: idempotent, and using SKIP LOCKED so it
 * never waits on a transaction that is already dealing with the same row.
 */
export async function releaseLapsedSubscriptions(
  pool: Pool,
  graceDays: number = SUBSCRIPTION_GRACE_DAYS,
): Promise<{ blockIds: string[]; tilesReleased: number }> {
  return withTransaction(pool, async (tx) => {
    // Two ways a planet stops being paid for: a subscription whose period ended
    // and was never renewed, and a trial that simply ran out. Both leave a
    // planet on the board with nothing behind it, so both are swept here.
    const expired = await tx.query<{ id: string }>(
      `UPDATE blocks
          SET status = 'expired', published_at = NULL
        WHERE id IN (
          SELECT id
            FROM blocks
           WHERE status IN ('live', 'pending_review')
             AND (
               (current_period_end IS NOT NULL
                 AND subscription_id IS NOT NULL
                 AND current_period_end < now() - make_interval(days => $1::int))
               OR (trial_ends_at IS NOT NULL
                 AND subscription_id IS NULL
                 AND trial_ends_at < now())
             )
           FOR UPDATE SKIP LOCKED
        )
        RETURNING id`,
      [graceDays],
    );

    const blockIds = expired.rows.map((row) => row.id);
    if (blockIds.length === 0) return { blockIds, tilesReleased: 0 };

    return { blockIds, tilesReleased: await releaseTiles(tx, blockIds) };
  });
}

/** The one place tiles go back on sale. */
async function releaseTiles(tx: Queryable, blockIds: readonly string[]): Promise<number> {
  const result = await tx.query(`DELETE FROM occupied_tiles WHERE block_id = ANY($1::uuid[])`, [
    blockIds,
  ]);
  return result.rowCount ?? 0;
}
