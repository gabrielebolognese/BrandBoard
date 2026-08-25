import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { BOARD_SIZE, MAX_BLOCK_SIZE } from "../config.js";
import { createTestUser, hasDatabase, resetBoard, setupTestDatabase } from "../test/db.js";

const suite = describe.skipIf(!hasDatabase);

suite("schema guarantees [requires DATABASE_URL]", () => {
  let pool: Pool;
  let alice: string;

  beforeAll(async () => {
    pool = await setupTestDatabase();
  }, 30_000);

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await resetBoard(pool);
    alice = await createTestUser(pool, "alice");
  });

  describe("board dimensions", () => {
    // The board size exists twice by necessity -- once for the application and
    // once for constraints the database enforces alone. This is the guard that
    // stops the two copies from drifting.
    it("agrees with src/config.ts", async () => {
      const result = await pool.query<{ board: number; max_block: number }>(
        `SELECT board_size() AS board, max_block_size() AS max_block`,
      );
      expect(result.rows[0]).toEqual({ board: BOARD_SIZE, max_block: MAX_BLOCK_SIZE });
    });
  });

  describe("occupied_tiles", () => {
    it("makes a double booking impossible at the storage layer", async () => {
      const first = await reserve(pool, alice, 103, 103, 1);
      const second = await reserve(pool, alice, 104, 104, 1);

      await pool.query(`INSERT INTO occupied_tiles (x, y, block_id) VALUES (103, 103, $1)`, [first]);

      await expect(
        pool.query(`INSERT INTO occupied_tiles (x, y, block_id) VALUES (103, 103, $1)`, [second]),
      ).rejects.toMatchObject({ code: "23505", constraint: "occupied_tiles_pkey" });
    });

    it("releases tiles when its block is deleted, which is what a rejection does", async () => {
      const block = await reserve(pool, alice, 108, 108, 1);
      await pool.query(`INSERT INTO occupied_tiles (x, y, block_id) VALUES (108, 108, $1)`, [block]);

      await pool.query(`DELETE FROM blocks WHERE id = $1`, [block]);

      const left = await pool.query(`SELECT 1 FROM occupied_tiles WHERE x = 108 AND y = 108`);
      expect(left.rowCount).toBe(0);
    });

    it("refuses coordinates off the board", async () => {
      const block = await reserve(pool, alice, 100, 100, 1);
      await expect(
        pool.query(`INSERT INTO occupied_tiles (x, y, block_id) VALUES ($1, 0, $2)`, [
          BOARD_SIZE,
          block,
        ]),
      ).rejects.toMatchObject({ constraint: "occupied_tiles_within_board" });
    });
  });

  describe("blocks", () => {
    it("refuses a size below one", async () => {
      await expect(reserve(pool, alice, 100, 100, 0)).rejects.toMatchObject({
        constraint: "blocks_size_range",
      });
    });

    it("refuses a planet larger than the cap, even where it would fit", async () => {
      // Past the overall ceiling and past every orbit's own limit, so the
      // database may cite either constraint. Both are check violations.
      await expect(reserve(pool, alice, 100, 100, MAX_BLOCK_SIZE + 1)).rejects.toMatchObject({
        code: "23514",
      });
    });

    it("accepts a planet right at the cap, in the orbit that allows it", async () => {
      await expect(reserve(pool, alice, 175, 150, MAX_BLOCK_SIZE)).resolves.toBeDefined();
    });

    it("refuses a planet too big for the orbit it sits in", async () => {
      // The outer reach takes six, and this is nine.
      await expect(reserve(pool, alice, 250, 150, 9)).rejects.toMatchObject({
        constraint: "blocks_size_fits_orbit",
      });
    });

    it("still refuses a planet that runs off the edge, at any size", async () => {
      // Off the square board is necessarily out of the universe too, so the
      // database may cite either constraint; both are check violations.
      await expect(reserve(pool, alice, 295, 150, 11)).rejects.toMatchObject({ code: "23514" });
    });

    it("refuses a planet in the void outside the orbits", async () => {
      await expect(reserve(pool, alice, 5, 5, 1)).rejects.toMatchObject({
        constraint: "blocks_within_universe",
      });
    });

    it("refuses to publish a block with nothing to render", async () => {
      const block = await reserve(pool, alice, 100, 100, 1);
      await expect(
        pool.query(
          `UPDATE blocks SET status = 'live', reserved_until = NULL, published_at = now()
            WHERE id = $1`,
          [block],
        ),
      ).rejects.toMatchObject({ constraint: "blocks_live_requires_content" });
    });

    it("publishes once the listing is filled in", async () => {
      const block = await reserve(pool, alice, 100, 100, 1);
      await expect(publish(pool, block, "alice")).resolves.toBeDefined();

      const row = await pool.query<{ status: string; reserved_until: Date | null }>(
        `SELECT status, reserved_until FROM blocks WHERE id = $1`,
        [block],
      );
      expect(row.rows[0]?.status).toBe("live");
      expect(row.rows[0]?.reserved_until).toBeNull();
    });

    it("requires a reserved block to carry a hold, and a live one not to", async () => {
      await expect(
        pool.query(
          `INSERT INTO blocks (user_id, x, y, size, status) VALUES ($1, 100, 100, 1, 'reserved')`,
          [alice],
        ),
      ).rejects.toMatchObject({ constraint: "blocks_reservation_window" });
    });

    it("keeps /b/[handle] unambiguous across live listings", async () => {
      const first = await reserve(pool, alice, 100, 100, 1);
      const second = await reserve(pool, alice, 101, 101, 1);
      await publish(pool, first, "creator");

      await expect(publish(pool, second, "CREATOR")).rejects.toMatchObject({
        constraint: "blocks_handle_lower_key",
      });
    });
  });

  describe("click_events", () => {
    it("counts one click per visitor per block per day", async () => {
      const block = await reserve(pool, alice, 100, 100, 1);
      const ip = Buffer.from("a".repeat(32));

      await pool.query(`INSERT INTO click_events (block_id, day, ip_hash) VALUES ($1, $2, $3)`, [
        block,
        "2026-08-23",
        ip,
      ]);
      await expect(
        pool.query(`INSERT INTO click_events (block_id, day, ip_hash) VALUES ($1, $2, $3)`, [
          block,
          "2026-08-23",
          ip,
        ]),
      ).rejects.toMatchObject({ constraint: "click_events_unique_per_day" });
    });
  });
});

async function reserve(
  pool: Pool,
  userId: string,
  x: number,
  y: number,
  size: number,
): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO blocks (user_id, x, y, size, status, reserved_until)
     VALUES ($1, $2, $3, $4, 'reserved', now() + interval '15 minutes')
     RETURNING id`,
    [userId, x, y, size],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error("insert returned no row");
  return row.id;
}

function publish(pool: Pool, blockId: string, handle: string): Promise<unknown> {
  return pool.query(
    `UPDATE blocks
        SET status = 'live',
            reserved_until = NULL,
            published_at = now(),
            image_url = 'https://cdn.example/a.webp',
            display_name = 'A Creator',
            handle = $2,
            primary_url = 'https://example.com'
      WHERE id = $1`,
    [blockId, handle],
  );
}
