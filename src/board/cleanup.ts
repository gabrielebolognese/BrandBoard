import type { Pool } from "pg";
import type { Queryable } from "../db/client.js";
import { withTransaction } from "../db/client.js";

export interface CleanupResult {
  readonly expiredBlockIds: string[];
  readonly releasedTiles: number;
}

/**
 * Expires lapsed reservations and frees their tiles.
 *
 * Runs inside the caller's transaction. Two callers exist and both must be
 * idempotent: every claim runs it first (so an active board self-heals), and a
 * scheduled sweep runs it every minute (so an idle board does not sit holding
 * tiles nobody paid for).
 *
 * Written as UPDATE ... RETURNING followed by a delete keyed on those ids,
 * rather than a delete driven by its own subquery. Same rows, one scan, and no
 * chance of the two statements disagreeing about which blocks lapsed.
 *
 * FOR UPDATE SKIP LOCKED means a claim never waits on another transaction's
 * cleanup of the same rows. A skipped row is simply cleaned up by whoever holds
 * it, or by the next sweep a minute later. The cost is a rare spurious 409 for
 * a tile that was moments from being freed; the caller can retry.
 */
export async function releaseExpiredReservations(tx: Queryable): Promise<CleanupResult> {
  const expired = await tx.query<{ id: string }>(
    `UPDATE blocks
        SET status = 'expired'
      WHERE id IN (
        SELECT id
          FROM blocks
         WHERE status = 'reserved'
           AND reserved_until < now()
         FOR UPDATE SKIP LOCKED
      )
      RETURNING id`,
  );

  const expiredBlockIds = expired.rows.map((row) => row.id);
  if (expiredBlockIds.length === 0) {
    return { expiredBlockIds, releasedTiles: 0 };
  }

  const released = await tx.query(`DELETE FROM occupied_tiles WHERE block_id = ANY($1::uuid[])`, [
    expiredBlockIds,
  ]);

  return { expiredBlockIds, releasedTiles: released.rowCount ?? 0 };
}

/** The scheduled entry point. Run this every minute. */
export async function runReservationSweep(pool: Pool): Promise<CleanupResult> {
  return withTransaction(pool, releaseExpiredReservations);
}
