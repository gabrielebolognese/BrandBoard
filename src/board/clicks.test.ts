import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clickSummary, hashVisitor, recordClick, totalClicks } from "./clicks.js";
import { createTestUser, hasDatabase, resetBoard, setupTestDatabase } from "../test/db.js";

const suite = describe.skipIf(!hasDatabase);

suite("click recording [requires DATABASE_URL]", () => {
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

  it("sends the visitor on and counts the click", async () => {
    const block = await live(pool, alice, "https://alice.example");

    const outcome = await recordClick(pool, block, "203.0.113.7");

    expect(outcome).toEqual({ url: "https://alice.example", counted: true });
    expect(await countOf(pool, block)).toBe(1);
  });

  it("counts the same visitor once a day, and still redirects them", async () => {
    const block = await live(pool, alice, "https://alice.example");

    await recordClick(pool, block, "203.0.113.7");
    const second = await recordClick(pool, block, "203.0.113.7");

    expect(second).toEqual({ url: "https://alice.example", counted: false });
    expect(await countOf(pool, block)).toBe(1);
  });

  it("counts a different visitor separately", async () => {
    const block = await live(pool, alice, "https://alice.example");

    await recordClick(pool, block, "203.0.113.7");
    await recordClick(pool, block, "198.51.100.4");

    expect(await countOf(pool, block)).toBe(2);
  });

  // The counter is the number an owner decides to renew on, so it must not be
  // able to run ahead of the events it is meant to summarise.
  it("never counts more than the events it recorded", async () => {
    const block = await live(pool, alice, "https://alice.example");

    await Promise.all(
      Array.from({ length: 20 }, (_, i) => recordClick(pool, block, `203.0.113.${i % 5}`)),
    );

    const events = await pool.query<{ count: string }>(
      `SELECT count(*)::text FROM click_events WHERE block_id = $1`,
      [block],
    );
    expect(await countOf(pool, block)).toBe(Number(events.rows[0]?.count));
    expect(await countOf(pool, block)).toBe(5);
  });

  it("does not resolve a planet that is not on the board", async () => {
    const reserved = await pool.query<{ id: string }>(
      `INSERT INTO blocks (user_id, x, y, size, status, reserved_until, primary_url)
       VALUES ($1, 120, 120, 1, 'reserved', now() + interval '15 minutes', 'https://nope.example')
       RETURNING id`,
      [alice],
    );
    const block = reserved.rows[0]?.id ?? "";

    expect(await recordClick(pool, block, "203.0.113.7")).toEqual({ url: null, counted: false });
  });

  it("does not fail on a planet that never existed", async () => {
    const outcome = await recordClick(pool, "00000000-0000-0000-0000-000000000000", "203.0.113.7");
    expect(outcome).toEqual({ url: null, counted: false });
  });

  it("reports a run of days with the quiet ones filled in", async () => {
    const block = await live(pool, alice, "https://alice.example");
    await recordClick(pool, block, "203.0.113.7");

    const summary = await clickSummary(pool, block, 7);

    expect(summary.daily).toHaveLength(7);
    expect(summary.daily.at(-1)?.clicks).toBe(1);
    expect(summary.total).toBe(1);
    expect(summary.last7).toBe(1);
    expect(await totalClicks(pool)).toBe(1);
  });

  it("hashes a visitor differently on a different day", () => {
    const monday = hashVisitor("203.0.113.7", new Date("2026-09-21T12:00:00Z"));
    const tuesday = hashVisitor("203.0.113.7", new Date("2026-09-22T12:00:00Z"));

    expect(monday.equals(tuesday)).toBe(false);
    expect(monday).toHaveLength(16);
  });
});

async function live(pool: Pool, userId: string, url: string): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO blocks
       (user_id, x, y, size, status, published_at, image_url, display_name, handle, primary_url)
     VALUES ($1, 150, 150, 1, 'live', now(), 'https://cdn.example/a.webp', 'Alice', 'alice', $2)
     RETURNING id`,
    [userId, url],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error("insert returned no row");
  return row.id;
}

async function countOf(pool: Pool, blockId: string): Promise<number> {
  const result = await pool.query<{ click_count: number }>(
    `SELECT click_count FROM blocks WHERE id = $1`,
    [blockId],
  );
  return result.rows[0]?.click_count ?? -1;
}
