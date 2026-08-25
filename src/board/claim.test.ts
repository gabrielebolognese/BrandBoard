import type { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  countTiles,
  createTestUser,
  hasDatabase,
  resetBoard,
  setupTestDatabase,
  sleep,
  statusOf,
  tilesOf,
} from "../test/db.js";
import { MAX_BLOCK_SIZE } from "../config.js";
import { runReservationSweep } from "./cleanup.js";
import { claimBlock, claimBlocks } from "./claim.js";
import {
  InvalidSizeError,
  OutOfBoundsError,
  OutsideUniverseError,
  TileConflictError,
} from "./errors.js";

// Skipped, loudly, when DATABASE_URL is unset: these assertions are about what
// PostgreSQL does under concurrency, and there is nothing to assert without it.
const suite = describe.skipIf(!hasDatabase);

suite("claiming blocks [requires DATABASE_URL]", () => {
  let pool: Pool;
  let alice: string;
  let bob: string;

  beforeAll(async () => {
    pool = await setupTestDatabase();
  }, 30_000);

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await resetBoard(pool);
    alice = await createTestUser(pool, "alice");
    bob = await createTestUser(pool, "bob");
  });

  describe("a successful claim", () => {
    it("reserves the block and writes one tile row per covered tile", async () => {
      const block = await claimBlock(pool, alice, { x: 112, y: 134, size: 3 });

      expect(await statusOf(pool, block.id)).toBe("reserved");
      expect(block.reservedUntil.getTime()).toBeGreaterThan(Date.now());
      expect(await tilesOf(pool, block.id)).toHaveLength(9);
      expect(await countTiles(pool)).toBe(9);
    });

    it("places blocks at any free anchor, not on a size-aligned grid", async () => {
      const first = await claimBlock(pool, alice, { x: 107, y: 103, size: 3 });
      const second = await claimBlock(pool, bob, { x: 110, y: 104, size: 2 });

      expect(await tilesOf(pool, first.id)).toHaveLength(9);
      expect(await tilesOf(pool, second.id)).toHaveLength(4);
      expect(await countTiles(pool)).toBe(13);
    });
  });

  describe("large blocks, up to the cap", () => {
    it("claims a 12x12 and holds all 144 tiles", async () => {
      const block = await claimBlock(pool, alice, { x: 120, y: 120, size: 12 });
      expect(await tilesOf(pool, block.id)).toHaveLength(144);
      expect(await countTiles(pool)).toBe(144);
    });

    it("claims a block at the cap and holds all 625 tiles", async () => {
      const block = await claimBlock(pool, alice, { x: 110, y: 110, size: MAX_BLOCK_SIZE });
      expect(await tilesOf(pool, block.id)).toHaveLength(625);
    });

    it("refuses anything past the cap, so no one can corner the board", async () => {
      await expect(
        claimBlock(pool, alice, { x: 100, y: 100, size: MAX_BLOCK_SIZE + 1 }),
      ).rejects.toBeInstanceOf(InvalidSizeError);
      expect(await countTiles(pool)).toBe(0);
    });

    it("still cannot overlap, however large it is", async () => {
      await claimBlock(pool, alice, { x: 150, y: 150, size: 1 });

      // A 20x20 covering that single tile loses to it: size buys nothing.
      await expect(claimBlock(pool, bob, { x: 140, y: 140, size: 20 })).rejects.toBeInstanceOf(
        TileConflictError,
      );
      expect(await countTiles(pool)).toBe(1);
    });

    it("lets a big block fill the gap around what is already held", async () => {
      await claimBlock(pool, alice, { x: 100, y: 100, size: 1 });
      const big = await claimBlock(pool, bob, { x: 101, y: 101, size: 20 });
      expect(await tilesOf(pool, big.id)).toHaveLength(400);
    });
  });

  describe("out of bounds", () => {
    it("rejects a planet that would run off the board and writes nothing", async () => {
      await expect(claimBlock(pool, alice, { x: 298, y: 298, size: 3 })).rejects.toBeInstanceOf(
        OutOfBoundsError,
      );
      expect(await countTiles(pool)).toBe(0);
    });

    it("rejects a spot inside the square board but outside the universe", async () => {
      // The corners of the addressable board are void: in bounds, not for sale.
      await expect(claimBlock(pool, alice, { x: 2, y: 2, size: 1 })).rejects.toBeInstanceOf(
        OutsideUniverseError,
      );
      expect(await countTiles(pool)).toBe(0);
    });

    it("is refused by the database too, not only by the application check", async () => {
      // Bypasses claimBlocks entirely: the CHECK constraint is the real floor.
      await expect(
        pool.query(
          `INSERT INTO blocks (user_id, x, y, size, status, reserved_until)
           VALUES ($1, 298, 298, 3, 'reserved', now() + interval '15 minutes')`,
          [alice],
        ),
      ).rejects.toMatchObject({ constraint: "blocks_within_board" });
    });
  });

  describe("collision", () => {
    it("returns 409 with the conflicting tiles when squares overlap", async () => {
      await claimBlock(pool, alice, { x: 100, y: 100, size: 2 });

      let caught: unknown;
      try {
        await claimBlock(pool, bob, { x: 101, y: 101, size: 2 });
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(TileConflictError);
      const conflict = caught as TileConflictError;
      expect(conflict.status).toBe(409);
      // Only the shared corner is taken; the other three tiles were free.
      expect(conflict.conflicts.map((c) => ({ x: c.x, y: c.y }))).toEqual([{ x: 101, y: 101 }]);
      expect(await countTiles(pool)).toBe(4);
    });

    it("does not relocate or partially place the losing block", async () => {
      await claimBlock(pool, alice, { x: 105, y: 105, size: 1 });
      await claimBlocks(pool, bob, [{ x: 105, y: 105, size: 1 }]).catch(() => undefined);

      const blocks = await pool.query<{ count: string }>(
        `SELECT count(*) FROM blocks WHERE user_id = $1`,
        [bob],
      );
      expect(Number(blocks.rows[0]?.count)).toBe(0);
      expect(await countTiles(pool)).toBe(1);
    });

    it("rejects a cart that overlaps itself", async () => {
      await expect(
        claimBlocks(pool, alice, [
          { x: 120, y: 120, size: 2 },
          { x: 121, y: 121, size: 2 },
        ]),
      ).rejects.toBeInstanceOf(TileConflictError);
      expect(await countTiles(pool)).toBe(0);
    });

    it("is all-or-nothing across a cart: one bad square drops the whole claim", async () => {
      await claimBlock(pool, alice, { x: 105, y: 105, size: 1 });

      await expect(
        claimBlocks(pool, bob, [
          { x: 140, y: 140, size: 2 }, // free
          { x: 105, y: 105, size: 1 }, // taken
        ]),
      ).rejects.toBeInstanceOf(TileConflictError);

      // (40, 40) must still be free, or the cart leaked a partial reservation.
      expect(await countTiles(pool)).toBe(1);
      const retry = await claimBlock(pool, bob, { x: 140, y: 140, size: 2 });
      expect(await tilesOf(pool, retry.id)).toHaveLength(4);
    });
  });

  describe("two concurrent claims for overlapping squares", () => {
    it("lets exactly one win, deterministically, with the loser blocked at the index", async () => {
      // Lock-step rather than a race, so this asserts the storage guarantee
      // instead of hoping the timing lines up. Both transactions are open at
      // once; the second is physically waiting on the first's index entry.
      const a = await pool.connect();
      const b = await pool.connect();
      try {
        await a.query("BEGIN");
        await b.query("BEGIN");

        const blockA = await insertReservedBlock(a, alice, 150, 150, 3);
        const blockB = await insertReservedBlock(b, bob, 151, 151, 3);

        await insertTiles(a, blockA, 150, 150, 3);
        // Not awaited: this blocks inside PostgreSQL until A commits or aborts.
        const contended = insertTiles(b, blockB, 151, 151, 3);
        await sleep(250);

        await a.query("COMMIT");

        await expect(contended).rejects.toMatchObject({
          code: "23505",
          constraint: "occupied_tiles_pkey",
        });
        await b.query("ROLLBACK");

        expect(await countTiles(pool)).toBe(9);
        expect(await tilesOf(pool, blockA)).toHaveLength(9);
        expect(await tilesOf(pool, blockB)).toHaveLength(0);
      } finally {
        a.release();
        b.release();
      }
    }, 20_000);

    it("survives the same race through the real claim path, repeatedly", async () => {
      // 20 rounds at fresh coordinates. Whichever way the two land, the board
      // must end up holding exactly one block's worth of tiles.
      for (let round = 0; round < 20; round += 1) {
        const x = 120 + round * 4;
        const results = await Promise.allSettled([
          claimBlock(pool, alice, { x, y: 150, size: 2 }),
          claimBlock(pool, bob, { x: x + 1, y: 151, size: 2 }),
        ]);

        const winners = results.filter((r) => r.status === "fulfilled");
        const losers = results.filter((r) => r.status === "rejected");

        expect(winners).toHaveLength(1);
        expect(losers).toHaveLength(1);
        for (const loser of losers) {
          expect(loser.reason).toBeInstanceOf(TileConflictError);
          expect((loser.reason as TileConflictError).status).toBe(409);
        }

        const winner = winners[0];
        if (winner?.status !== "fulfilled") throw new Error("unreachable");
        expect(await tilesOf(pool, winner.value.id)).toHaveLength(4);
      }

      // 20 rounds, one 2x2 winner each.
      expect(await countTiles(pool)).toBe(80);
    }, 60_000);
  });

  describe("reservations that lapse", () => {
    it("frees its tiles once the hold has passed, and the square can be claimed again", async () => {
      const abandoned = await claimBlock(pool, alice, { x: 160, y: 160, size: 2 });

      // 16 minutes pass without payment.
      await pool.query(
        `UPDATE blocks SET reserved_until = now() - interval '1 minute' WHERE id = $1`,
        [abandoned.id],
      );

      const replacement = await claimBlock(pool, bob, { x: 160, y: 160, size: 2 });

      expect(await statusOf(pool, abandoned.id)).toBe("expired");
      expect(await tilesOf(pool, abandoned.id)).toHaveLength(0);
      expect(await tilesOf(pool, replacement.id)).toHaveLength(4);
      expect(await countTiles(pool)).toBe(4);
    });

    it("still frees them on an idle board, via the scheduled sweep", async () => {
      const abandoned = await claimBlock(
        pool,
        alice,
        { x: 170, y: 170, size: 2 },
        { reservationMinutes: -1 },
      );
      expect(await countTiles(pool)).toBe(4);

      const first = await runReservationSweep(pool);
      expect(first.expiredBlockIds).toEqual([abandoned.id]);
      expect(first.releasedTiles).toBe(4);
      expect(await countTiles(pool)).toBe(0);

      // Idempotent: the every-minute job must be safe to run over and over.
      const second = await runReservationSweep(pool);
      expect(second.expiredBlockIds).toEqual([]);
      expect(second.releasedTiles).toBe(0);
      expect(await statusOf(pool, abandoned.id)).toBe("expired");
    });

    it("leaves a hold that has not lapsed alone", async () => {
      const live = await claimBlock(pool, alice, { x: 180, y: 180, size: 1 });

      const sweep = await runReservationSweep(pool);

      expect(sweep.expiredBlockIds).toEqual([]);
      expect(await statusOf(pool, live.id)).toBe("reserved");
      expect(await countTiles(pool)).toBe(1);
    });
  });
});

/** Raw inserts for the lock-step test, which needs to hold a transaction open. */
async function insertReservedBlock(
  client: { query: Pool["query"] },
  userId: string,
  x: number,
  y: number,
  size: number,
): Promise<string> {
  const result = await client.query<{ id: string }>(
    `INSERT INTO blocks (user_id, x, y, size, status, reserved_until)
     VALUES ($1, $2, $3, $4, 'reserved', now() + interval '15 minutes')
     RETURNING id`,
    [userId, x, y, size],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error("insert returned no row");
  return row.id;
}

async function insertTiles(
  client: { query: Pool["query"] },
  blockId: string,
  x: number,
  y: number,
  size: number,
): Promise<void> {
  const xs: number[] = [];
  const ys: number[] = [];
  for (let dx = 0; dx < size; dx += 1) {
    for (let dy = 0; dy < size; dy += 1) {
      xs.push(x + dx);
      ys.push(y + dy);
    }
  }
  await client.query(
    `INSERT INTO occupied_tiles (x, y, block_id)
     SELECT t.x, t.y, $3::uuid
       FROM unnest($1::smallint[], $2::smallint[]) AS t(x, y)
      ORDER BY t.x, t.y`,
    [xs, ys, blockId],
  );
}
