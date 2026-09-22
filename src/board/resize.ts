import type { Pool } from "pg";
import { MAX_BLOCK_SIZE, monthlyPriceCents, orbitAt, sizeCapAt } from "../config.js";
import { isTileCollision, withTransaction } from "../db/client.js";
import type { Queryable } from "../db/client.js";
import { describeConflicts, sortTiles } from "./claim.js";
import { releaseExpiredReservations } from "./cleanup.js";
import {
  BlockNotChangeableError,
  ChangeNotAllowedError,
  InvalidSizeError,
  NotYourBlockError,
  OutOfBoundsError,
  OutsideUniverseError,
  SizeNotAllowedHereError,
  TileConflictError,
  UnknownBlockError,
} from "./errors.js";
import { isInBounds, isInUniverse, isValidSize, tileKey, tilesForBlock } from "./geometry.js";
import type { Placement, Tile } from "./geometry.js";

/**
 * Growing a planet, and moving one.
 *
 * This is the strongest upsell the product has, because it is the one where the
 * person already knows what they bought and wants more of it. Someone who has
 * watched their clicks for a month and wants to go from four tiles to nine, or
 * to move in from the outer reach to the inner belt, is the easiest sale here.
 *
 * Underneath, both are ordinary claims. occupied_tiles stays the only thing
 * that decides whether a square is free, and a grow that would overlap someone
 * else is refused by the same primary key that refuses a first purchase. There
 * is no availability query anywhere in here whose answer could go stale.
 */

export type ChangeKind = "grow" | "move";

export interface ChangeQuote {
  readonly kind: ChangeKind;
  readonly from: Placement;
  readonly to: Placement;
  readonly monthlyCentsBefore: number;
  readonly monthlyCentsAfter: number;
  /** Signed. Negative when the new ground is cheaper than the old. */
  readonly monthlyDeltaCents: number;
  readonly tilesBefore: number;
  readonly tilesAfter: number;
}

export interface AppliedChange extends ChangeQuote {
  readonly blockId: string;
  readonly changeId: string;
}

export interface ChangeOptions {
  /** Ties the change to the payment that covers its difference. */
  readonly checkoutSessionId?: string;
}

/**
 * Which of the two operations this is, or why it is neither.
 *
 * Growing keeps every tile it already has and takes more. Moving keeps its size
 * and goes somewhere else. The reason growing has to keep its ground is that a
 * "grow" which also relocates is really a move and a grow at once, and the two
 * have different prices, different failure modes and different things to say
 * when they collide -- so it is refused rather than guessed at.
 *
 * Shrinking is not offered. It is a downgrade dressed as a feature, and the
 * honest version of it is cancelling and buying something smaller.
 */
export function classifyChange(from: Placement, to: Placement): ChangeKind {
  if (from.x === to.x && from.y === to.y && from.size === to.size) {
    throw new ChangeNotAllowedError("That is where the planet already is.");
  }

  if (to.size < from.size) {
    throw new ChangeNotAllowedError(
      `A planet cannot be made smaller. This one is ${from.size}x${from.size}.`,
    );
  }

  if (to.size === from.size) return "move";

  const keepsItsGround =
    to.x <= from.x &&
    to.y <= from.y &&
    to.x + to.size >= from.x + from.size &&
    to.y + to.size >= from.y + from.size;

  if (!keepsItsGround) {
    throw new ChangeNotAllowedError(
      "A planet growing has to keep the ground it already holds. Move it first, then grow it.",
    );
  }

  return "grow";
}

/**
 * What a change would cost, without touching the board.
 *
 * Priced the same way a first purchase is: summed per tile from the orbit each
 * tile falls in. A planet that grows across an orbit boundary pays the real
 * rate for the expensive tiles it picks up, not an average.
 */
export function quoteChange(from: Placement, to: Placement): ChangeQuote {
  const kind = classifyChange(from, to);
  validateDestination(to);

  const before = monthlyPriceCents(from.x, from.y, from.size);
  const after = monthlyPriceCents(to.x, to.y, to.size);

  return {
    kind,
    from,
    to,
    monthlyCentsBefore: before,
    monthlyCentsAfter: after,
    monthlyDeltaCents: after - before,
    tilesBefore: from.size * from.size,
    tilesAfter: to.size * to.size,
  };
}

/**
 * The same rules a first purchase is held to.
 *
 * The database checks all of this again in its CHECK constraints; this exists
 * to produce a message someone can act on, not to be the guarantee.
 */
function validateDestination(to: Placement): void {
  if (!isValidSize(to.size)) throw new InvalidSizeError(to.size, MAX_BLOCK_SIZE);
  if (!isInBounds(to)) throw new OutOfBoundsError(to.x, to.y, to.size);
  if (!isInUniverse(to)) throw new OutsideUniverseError(to.x, to.y, to.size);

  const cap = sizeCapAt(to.x, to.y, to.size);
  if (to.size > cap) {
    const middle = Math.floor(to.size / 2);
    const orbit = orbitAt(to.x + middle, to.y + middle);
    throw new SizeNotAllowedHereError(to.size, cap, orbit?.label ?? "That orbit");
  }
}

interface BlockRow {
  readonly id: string;
  readonly user_id: string;
  readonly x: number;
  readonly y: number;
  readonly size: number;
  readonly status: string;
}

/**
 * Grows or moves a planet, in one transaction.
 *
 *   BEGIN
 *     release lapsed reservations
 *     lock the block row, check who owns it and whether it is on the board
 *     DELETE the tiles it holds and will not hold any more
 *     INSERT the tiles it does not hold yet, in (x, y) order
 *     UPDATE the block to its new square
 *     INSERT the record of what changed
 *   COMMIT
 *
 * The insert is still the collision check, exactly as it is for a first claim.
 * If any tile of the destination belongs to someone else, the primary key
 * refuses it, the whole transaction rolls back, and the planet keeps the square
 * it already had. A failed move loses nothing -- the old tiles were deleted in
 * the same transaction, so the rollback puts them back.
 *
 * New tiles go in on the same ascending (x, y) ordering that claim.ts uses.
 * That ordering is what makes this safe to run against concurrent claims: a
 * transaction only ever waits on a key it is inserting, both sides insert in
 * ascending order, so there is no pair that can wait on each other. The delete
 * only touches rows this block already owns, which nobody else can be holding.
 */
export async function changeBlock(
  pool: Pool,
  userId: string,
  blockId: string,
  to: Placement,
  options: ChangeOptions = {},
): Promise<AppliedChange> {
  validateDestination(to);

  const newTiles = sortTiles(tilesForBlock(to));

  try {
    return await withTransaction(pool, async (tx) => {
      await releaseExpiredReservations(tx);

      const block = await lockBlock(tx, blockId);
      if (block === null) throw new UnknownBlockError(blockId);
      if (block.user_id !== userId) throw new NotYourBlockError(blockId);
      if (block.status !== "live") throw new BlockNotChangeableError(block.status);

      const from: Placement = { x: block.x, y: block.y, size: block.size };
      const quote = quoteChange(from, to);

      await moveTiles(tx, blockId, from, to);

      await tx.query(`UPDATE blocks SET x = $2, y = $3, size = $4 WHERE id = $1`, [
        blockId,
        to.x,
        to.y,
        to.size,
      ]);

      const changeId = await recordChange(tx, blockId, quote, options.checkoutSessionId ?? null);
      return { ...quote, blockId, changeId };
    });
  } catch (error) {
    if (isTileCollision(error)) {
      const { conflicts, total } = await describeConflicts(pool, newTiles, error);
      throw new TileConflictError(conflicts, total);
    }
    throw error;
  }
}

/**
 * Locks the planet for the length of the change.
 *
 * Two changes to the same planet arriving together would otherwise each read
 * the old square, and the second would compute its delete set from a position
 * the planet has already left.
 */
async function lockBlock(tx: Queryable, blockId: string): Promise<BlockRow | null> {
  const result = await tx.query<BlockRow>(
    `SELECT id, user_id, x, y, size, status::text AS status
       FROM blocks WHERE id = $1 FOR UPDATE`,
    [blockId],
  );
  return result.rows[0] ?? null;
}

/**
 * Releases what the planet no longer covers and takes what it now does.
 *
 * The two sets are differences rather than "delete everything, insert
 * everything": a move that overlaps its own old position would otherwise delete
 * and re-insert the same key inside one transaction, which works but reads as
 * though the tile was free for an instant. It never was.
 */
async function moveTiles(
  tx: Queryable,
  blockId: string,
  from: Placement,
  to: Placement,
): Promise<void> {
  const wanted = new Set(tilesForBlock(to).map(tileKey));
  const held = new Set(tilesForBlock(from).map(tileKey));

  const release = tilesForBlock(from).filter((tile) => !wanted.has(tileKey(tile)));
  const take = sortTiles(tilesForBlock(to).filter((tile: Tile) => !held.has(tileKey(tile))));

  if (release.length > 0) {
    await tx.query(
      `DELETE FROM occupied_tiles
        WHERE block_id = $1
          AND (x, y) IN (SELECT * FROM unnest($2::smallint[], $3::smallint[]))`,
      [blockId, release.map((tile) => tile.x), release.map((tile) => tile.y)],
    );
  }

  if (take.length > 0) {
    await tx.query(
      `INSERT INTO occupied_tiles (x, y, block_id)
       SELECT t.x, t.y, $3::uuid
         FROM unnest($1::smallint[], $2::smallint[]) AS t(x, y)
        ORDER BY t.x, t.y`,
      [take.map((tile) => tile.x), take.map((tile) => tile.y), blockId],
    );
  }
}

/**
 * The record of what changed, and what it changed the bill to.
 *
 * Charging the difference is the payment provider's problem. Knowing the
 * difference, and being able to answer "why did my price change" a year later,
 * is ours.
 */
async function recordChange(
  tx: Queryable,
  blockId: string,
  quote: ChangeQuote,
  checkoutSessionId: string | null,
): Promise<string> {
  const result = await tx.query<{ id: string }>(
    `INSERT INTO block_changes
       (block_id, kind, from_x, from_y, from_size, to_x, to_y, to_size,
        monthly_delta_cents, checkout_session_id)
     VALUES ($1, $2::block_change_kind, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING id`,
    [
      blockId,
      quote.kind,
      quote.from.x,
      quote.from.y,
      quote.from.size,
      quote.to.x,
      quote.to.y,
      quote.to.size,
      quote.monthlyDeltaCents,
      checkoutSessionId,
    ],
  );

  const row = result.rows[0];
  if (row === undefined) throw new Error("block_changes insert returned no row");
  return row.id;
}

export interface ChangeRecord {
  readonly id: string;
  readonly kind: ChangeKind;
  readonly from: Placement;
  readonly to: Placement;
  readonly monthlyDeltaCents: number;
  readonly createdAt: Date;
}

/** Everything that has happened to a planet, newest first. */
export async function changeHistory(pool: Pool, blockId: string): Promise<ChangeRecord[]> {
  const result = await pool.query<{
    id: string;
    kind: ChangeKind;
    from_x: number;
    from_y: number;
    from_size: number;
    to_x: number;
    to_y: number;
    to_size: number;
    monthly_delta_cents: number;
    created_at: Date;
  }>(
    `SELECT id, kind, from_x, from_y, from_size, to_x, to_y, to_size,
            monthly_delta_cents, created_at
       FROM block_changes
      WHERE block_id = $1
      ORDER BY created_at DESC`,
    [blockId],
  );

  return result.rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    from: { x: row.from_x, y: row.from_y, size: row.from_size },
    to: { x: row.to_x, y: row.to_y, size: row.to_size },
    monthlyDeltaCents: row.monthly_delta_cents,
    createdAt: row.created_at,
  }));
}
