import type { Pool } from "pg";
import { RESERVATION_TTL_MINUTES } from "../config.js";
import { isTileCollision, tileFromErrorDetail, withTransaction } from "../db/client.js";
import type { Queryable } from "../db/client.js";
import { releaseExpiredReservations } from "./cleanup.js";
import {
  EmptyClaimError,
  InvalidSizeError,
  OutOfBoundsError,
  TileConflictError,
} from "./errors.js";
import type { ConflictingTile } from "./errors.js";
import { isInBounds, isValidSize, placementsOverlap, tileKey, tilesForBlock } from "./geometry.js";
import type { Placement, Tile } from "./geometry.js";

export interface ClaimedBlock {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly size: number;
  readonly reservedUntil: Date;
}

export interface ClaimOptions {
  /** Overridable so tests can reserve in the past. Production uses the default. */
  readonly reservationMinutes?: number;
}

/**
 * Reserves one or more blocks for a user in a single atomic transaction.
 *
 * A cart checks out as one claim: either every square in it is held, or none
 * is. The sequence is exactly:
 *
 *   BEGIN
 *     release lapsed reservations, freeing their tiles
 *     INSERT the blocks as 'reserved' with a 15 minute hold
 *     INSERT one occupied_tiles row per covered tile
 *   COMMIT
 *
 * The tile insert is the collision check. There is no "is this free?" query
 * whose answer could go stale between the read and the write -- the primary key
 * on (x, y) refuses the second writer, whatever order the two arrive in.
 *
 * On collision this throws TileConflictError (HTTP 409) carrying the offending
 * coordinates. It does not retry and it does not relocate the block: the user
 * picked that square, and the UI has to tell them it is gone.
 */
export async function claimBlocks(
  pool: Pool,
  userId: string,
  placements: readonly Placement[],
  options: ClaimOptions = {},
): Promise<ClaimedBlock[]> {
  validateClaim(placements);

  const reservationMinutes = options.reservationMinutes ?? RESERVATION_TTL_MINUTES;
  const requestedTiles = sortTiles(placements.flatMap((placement) => tilesForBlock(placement)));

  try {
    return await withTransaction(pool, async (tx) => {
      await releaseExpiredReservations(tx);
      const blocks = await insertReservedBlocks(tx, userId, placements, reservationMinutes);
      await occupyTiles(tx, blocks);
      return blocks;
    });
  } catch (error) {
    if (isTileCollision(error)) {
      const { conflicts, total } = await describeConflicts(pool, requestedTiles, error);
      throw new TileConflictError(conflicts, total);
    }
    throw error;
  }
}

/** Single-block convenience wrapper. */
export async function claimBlock(
  pool: Pool,
  userId: string,
  placement: Placement,
  options: ClaimOptions = {},
): Promise<ClaimedBlock> {
  const [block] = await claimBlocks(pool, userId, [placement], options);
  if (block === undefined) {
    throw new Error("claimBlocks returned no block for a single placement.");
  }
  return block;
}

/**
 * Rejected before any connection is opened. These are client mistakes, not
 * contention, and they carry a 400 rather than a 409.
 *
 * The database enforces size and bounds again via CHECK constraints; this pass
 * exists to produce a usable error message, not to be the guarantee.
 */
function validateClaim(placements: readonly Placement[]): void {
  if (placements.length === 0) throw new EmptyClaimError();

  for (const placement of placements) {
    if (!isValidSize(placement.size)) throw new InvalidSizeError(placement.size);
    if (!isInBounds(placement)) {
      throw new OutOfBoundsError(placement.x, placement.y, placement.size);
    }
  }

  // A cart that overlaps itself would also fail on the unique key, but the
  // conflict read-back would then show nothing held by anyone else, which reads
  // as a phantom. Catch it here, where the cause is obvious.
  for (let i = 0; i < placements.length; i += 1) {
    for (let j = i + 1; j < placements.length; j += 1) {
      const a = placements[i];
      const b = placements[j];
      if (a === undefined || b === undefined) continue;
      if (placementsOverlap(a, b)) {
        const inB = new Set(tilesForBlock(b).map(tileKey));
        const shared = tilesForBlock(a)
          .filter((tile) => inB.has(tileKey(tile)))
          .map((tile) => ({ x: tile.x, y: tile.y, blockId: null }));
        throw new TileConflictError(shared);
      }
    }
  }
}

async function insertReservedBlocks(
  tx: Queryable,
  userId: string,
  placements: readonly Placement[],
  reservationMinutes: number,
): Promise<ClaimedBlock[]> {
  const result = await tx.query<{
    id: string;
    x: number;
    y: number;
    size: number;
    reserved_until: Date;
  }>(
    `INSERT INTO blocks (user_id, x, y, size, status, reserved_until)
     SELECT $1::uuid, p.x, p.y, p.size, 'reserved', now() + make_interval(mins => $5::int)
       FROM unnest($2::smallint[], $3::smallint[], $4::smallint[]) AS p(x, y, size)
     RETURNING id, x, y, size, reserved_until`,
    [
      userId,
      placements.map((p) => p.x),
      placements.map((p) => p.y),
      placements.map((p) => p.size),
      reservationMinutes,
    ],
  );

  return result.rows.map((row) => ({
    id: row.id,
    x: row.x,
    y: row.y,
    size: row.size,
    reservedUntil: row.reserved_until,
  }));
}

/**
 * The moment of truth. One row per tile; a duplicate key here means someone
 * else got there first.
 *
 * Rows go in on a fixed (x, y) ordering so that concurrent claims for
 * overlapping squares always contend on the same key first. Without it, two
 * claims could each hold part of the other's square and deadlock instead of
 * one of them cleanly losing.
 */
async function occupyTiles(tx: Queryable, blocks: readonly ClaimedBlock[]): Promise<void> {
  const rows = sortTiles(
    blocks.flatMap((block) =>
      tilesForBlock(block).map((tile) => ({ x: tile.x, y: tile.y, blockId: block.id })),
    ),
  );

  await tx.query(
    `INSERT INTO occupied_tiles (x, y, block_id)
     SELECT t.x, t.y, t.block_id
       FROM unnest($1::smallint[], $2::smallint[], $3::uuid[]) AS t(x, y, block_id)
      ORDER BY t.x, t.y`,
    [rows.map((r) => r.x), rows.map((r) => r.y), rows.map((r) => r.blockId)],
  );
}

/**
 * Reads back which of the requested tiles are actually held, for the 409 body.
 *
 * This runs after the rollback, on a fresh connection, so it is a snapshot for
 * the UI rather than a statement about the failed transaction. The tile named
 * in the driver's error detail is the one that truly lost the race, so it is
 * always included even when the read comes back empty.
 *
 * Since a block can be any size, the list is capped: a 100x100 claim landing on
 * a busy board would otherwise return thousands of coordinates in the 409. The
 * count is reported in full.
 */
const MAX_REPORTED_CONFLICTS = 256;

async function describeConflicts(
  pool: Pool,
  requestedTiles: readonly Tile[],
  error: unknown,
): Promise<{ conflicts: ConflictingTile[]; total: number }> {
  const result = await pool.query<{ x: number; y: number; block_id: string; total: string }>(
    `SELECT t.x, t.y, t.block_id, count(*) OVER () AS total
       FROM occupied_tiles t
       JOIN unnest($1::smallint[], $2::smallint[]) AS q(x, y)
         ON q.x = t.x AND q.y = t.y
      ORDER BY t.x, t.y
      LIMIT ${MAX_REPORTED_CONFLICTS}`,
    [requestedTiles.map((t) => t.x), requestedTiles.map((t) => t.y)],
  );

  const conflicts: ConflictingTile[] = result.rows.map((row) => ({
    x: row.x,
    y: row.y,
    blockId: row.block_id,
  }));

  const reported = tileFromErrorDetail(error);
  if (reported !== null && !conflicts.some((c) => c.x === reported.x && c.y === reported.y)) {
    conflicts.push({ x: reported.x, y: reported.y, blockId: null });
  }

  const total = Number(result.rows[0]?.total ?? conflicts.length);
  return { conflicts, total: Math.max(total, conflicts.length) };
}

function sortTiles<T extends Tile>(tiles: T[]): T[] {
  return [...tiles].sort((a, b) => (a.x === b.x ? a.y - b.y : a.x - b.x));
}
