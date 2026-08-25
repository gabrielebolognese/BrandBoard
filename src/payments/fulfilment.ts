import type { Pool } from "pg";
import { withTransaction } from "../db/client.js";
import type { Queryable } from "../db/client.js";

/**
 * Turning a completed payment into delivered tiles.
 *
 * The case this exists for: a reservation holds tiles for fifteen minutes, and
 * a payment can complete after that. By the time the money lands, someone else
 * may hold the square. Taking payment for tiles we cannot deliver is the worst
 * outcome in the product, so fulfilment re-checks ownership rather than
 * trusting that the reservation survived, and records a refund for anything it
 * cannot deliver.
 *
 * occupied_tiles is the authority here as everywhere else: a block is
 * deliverable when it still holds every one of its tiles, not when a timestamp
 * says its hold has not expired.
 */

export type RefundReason = "tiles_lost" | "rejected_in_review" | "subscription_lapsed";

export interface BlockSummary {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly size: number;
  readonly tiles: number;
  readonly monthlyCents: number;
}

export interface FulfilmentResult {
  readonly checkoutId: string;
  readonly status: "fulfilled" | "partially_fulfilled" | "nothing_delivered" | "unknown_checkout";
  /** Moved to pending_review. Not visible yet: an admin still has to approve. */
  readonly delivered: BlockSummary[];
  /** Tiles were gone by the time the money arrived. A refund is owed for these. */
  readonly lost: BlockSummary[];
  readonly refundCents: number;
}

export interface FulfilPaymentInput {
  readonly checkoutId: string;
  readonly rateCentsPerTilePerMonth: number;
  readonly subscriptionId?: string | null;
  readonly currentPeriodEnd?: Date | null;
}

/**
 * Delivers what a paid checkout can still be given, and books a refund for the
 * rest. Safe to run twice: blocks already delivered are reported as delivered
 * and not touched again, so a replayed event changes nothing.
 */
export async function fulfilPayment(
  pool: Pool,
  input: FulfilPaymentInput,
): Promise<FulfilmentResult> {
  const { checkoutId, rateCentsPerTilePerMonth } = input;

  return withTransaction(pool, async (tx) => {
    // Locking the rows keeps the reservation sweep off them: its cleanup uses
    // FOR UPDATE SKIP LOCKED, so it passes over anything held here. Whatever it
    // did before this point is already visible below, and anything after it is
    // impossible, because a block that leaves 'reserved' is no longer a
    // candidate for expiry at all.
    const blocks = await tx.query<{ id: string; x: number; y: number; size: number; status: string }>(
      `SELECT id, x, y, size, status
         FROM blocks
        WHERE checkout_session_id = $1
        ORDER BY x, y
        FOR UPDATE`,
      [checkoutId],
    );

    if (blocks.rows.length === 0) {
      return {
        checkoutId,
        status: "unknown_checkout" as const,
        delivered: [],
        lost: [],
        refundCents: 0,
      };
    }

    const ids = blocks.rows.map((row) => row.id);
    const counts = await tx.query<{ block_id: string; tiles: number }>(
      `SELECT block_id, count(*)::int AS tiles
         FROM occupied_tiles
        WHERE block_id = ANY($1::uuid[])
        GROUP BY block_id`,
      [ids],
    );
    const heldTiles = new Map(counts.rows.map((row) => [row.block_id, row.tiles]));

    const toDeliver: BlockSummary[] = [];
    const delivered: BlockSummary[] = [];
    const lost: BlockSummary[] = [];

    for (const row of blocks.rows) {
      const summary = describe(row, rateCentsPerTilePerMonth);
      const holdsEverything = (heldTiles.get(row.id) ?? 0) === summary.tiles;

      if (row.status === "pending_review" || row.status === "live") {
        // Already handled by an earlier delivery of this same event.
        delivered.push(summary);
      } else if (row.status === "reserved" && holdsEverything) {
        toDeliver.push(summary);
      } else {
        lost.push(summary);
      }
    }

    if (toDeliver.length > 0) {
      await tx.query(
        `UPDATE blocks
            SET status = 'pending_review',
                reserved_until = NULL,
                subscription_id = COALESCE($2, subscription_id),
                current_period_end = COALESCE($3, current_period_end)
          WHERE id = ANY($1::uuid[])`,
        [toDeliver.map((b) => b.id), input.subscriptionId ?? null, input.currentPeriodEnd ?? null],
      );
      delivered.push(...toDeliver);
    }

    for (const block of lost) {
      await recordRefund(tx, {
        blockId: block.id,
        checkoutId,
        reason: "tiles_lost",
        amountCents: block.monthlyCents,
      });
    }

    const refundCents = lost.reduce((sum, block) => sum + block.monthlyCents, 0);
    const status =
      lost.length === 0
        ? ("fulfilled" as const)
        : delivered.length === 0
          ? ("nothing_delivered" as const)
          : ("partially_fulfilled" as const);

    return { checkoutId, status, delivered, lost, refundCents };
  });
}

function describe(
  row: { id: string; x: number; y: number; size: number },
  rateCentsPerTilePerMonth: number,
): BlockSummary {
  const tiles = row.size * row.size;
  return {
    id: row.id,
    x: row.x,
    y: row.y,
    size: row.size,
    tiles,
    // Derived here, never taken from the provider's payload: what we owe back
    // is decided by what was bought, not by what a webhook claims was paid.
    monthlyCents: tiles * rateCentsPerTilePerMonth,
  };
}

// ---------------------------------------------------------------------------
// Refunds
// ---------------------------------------------------------------------------

/**
 * Books an obligation to refund. Writing it down comes first and issuing it
 * comes later, so a provider call that fails leaves a record to retry from
 * instead of losing the obligation entirely.
 *
 * One row per block per reason, enforced by a unique key, so replaying whatever
 * caused it cannot make us owe the same money twice.
 */
export async function recordRefund(
  db: Queryable,
  refund: {
    blockId: string;
    checkoutId?: string | null;
    reason: RefundReason;
    amountCents: number;
  },
): Promise<{ recorded: boolean }> {
  const result = await db.query(
    `INSERT INTO refunds_owed (block_id, checkout_session_id, reason, amount_cents)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (block_id, reason) DO NOTHING`,
    [refund.blockId, refund.checkoutId ?? null, refund.reason, refund.amountCents],
  );
  return { recorded: (result.rowCount ?? 0) > 0 };
}

export interface OutstandingRefund {
  readonly id: string;
  readonly blockId: string;
  readonly checkoutId: string | null;
  readonly reason: RefundReason;
  readonly amountCents: number;
  readonly createdAt: Date;
}

/** The work queue a provider adapter drains. */
export async function outstandingRefunds(pool: Pool, limit = 100): Promise<OutstandingRefund[]> {
  const result = await pool.query<{
    id: string;
    block_id: string;
    checkout_session_id: string | null;
    reason: RefundReason;
    amount_cents: number;
    created_at: Date;
  }>(
    `SELECT id, block_id, checkout_session_id, reason, amount_cents, created_at
       FROM refunds_owed
      WHERE settled_at IS NULL
      ORDER BY created_at
      LIMIT $1`,
    [limit],
  );

  return result.rows.map((row) => ({
    id: row.id,
    blockId: row.block_id,
    checkoutId: row.checkout_session_id,
    reason: row.reason,
    amountCents: row.amount_cents,
    createdAt: row.created_at,
  }));
}

/** Called once the provider confirms the money went back, with its reference. */
export async function settleRefund(
  pool: Pool,
  id: string,
  providerRef: string,
): Promise<{ settled: boolean }> {
  const result = await pool.query(
    `UPDATE refunds_owed
        SET settled_at = now(), provider_ref = $2
      WHERE id = $1 AND settled_at IS NULL`,
    [id, providerRef],
  );
  return { settled: (result.rowCount ?? 0) > 0 };
}
