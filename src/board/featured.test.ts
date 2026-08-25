import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  FEATURED_ADDITIONAL_DAY_CENTS,
  FEATURED_FIRST_DAY_CENTS,
  FEATURED_MAX_DAYS,
  featuredPriceCents,
  isValidFeaturedDays,
} from "../config.js";
import { createTestUser, hasDatabase, resetBoard, setupTestDatabase } from "../test/db.js";
import { claimBlock } from "./claim.js";
import { InvalidFeaturedDaysError, activeFeatured, featureBlock } from "./featured.js";

describe("featured pricing", () => {
  it("charges 10 for the first day and 8 for each one after", () => {
    expect(FEATURED_FIRST_DAY_CENTS).toBe(1000);
    expect(FEATURED_ADDITIONAL_DAY_CENTS).toBe(800);

    expect(featuredPriceCents(1)).toBe(1000);
    expect(featuredPriceCents(2)).toBe(1800);
    expect(featuredPriceCents(3)).toBe(2600);
    expect(featuredPriceCents(10)).toBe(8200);
  });

  it("runs from one to ten days and refuses anything else", () => {
    expect(FEATURED_MAX_DAYS).toBe(10);
    expect([1, 2, 5, 10].every(isValidFeaturedDays)).toBe(true);
    expect([0, -1, 11, 2.5].every((days) => !isValidFeaturedDays(days))).toBe(true);
    expect(() => featuredPriceCents(11)).toThrow();
    expect(() => featuredPriceCents(0)).toThrow();
  });

  it("gets steadily cheaper per day without ever going free", () => {
    for (let days = 2; days <= FEATURED_MAX_DAYS; days += 1) {
      const step = featuredPriceCents(days) - featuredPriceCents(days - 1);
      expect(step).toBe(FEATURED_ADDITIONAL_DAY_CENTS);
      expect(featuredPriceCents(days) / days).toBeLessThan(featuredPriceCents(days - 1) / (days - 1));
    }
  });
});

const suite = describe.skipIf(!hasDatabase);

suite("featured windows [requires DATABASE_URL]", () => {
  let pool: Pool;
  let owner: string;

  beforeAll(async () => {
    pool = await setupTestDatabase();
  }, 30_000);

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await resetBoard(pool);
    owner = await createTestUser(pool, "owner");
  });

  async function liveBlock(x: number, y: number, handle: string): Promise<string> {
    const block = await claimBlock(pool, owner, { x, y, size: 2 });
    await pool.query(
      `UPDATE blocks
          SET status = 'live', reserved_until = NULL, published_at = now(),
              display_name = $2, handle = $2,
              image_url = 'https://cdn.example/a.webp', primary_url = 'https://example.com'
        WHERE id = $1`,
      [block.id, handle],
    );
    return block.id;
  }

  it("runs 24 hours from the moment it is bought", async () => {
    const block = await liveBlock(0, 0, "one");
    const slot = await featureBlock(pool, block, 1);

    const hours = (slot.expiresAt.getTime() - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(23.9);
    expect(hours).toBeLessThan(24.1);
  });

  /**
   * The rule that matters: two windows bought five hours apart expire five
   * hours apart. Nothing resets at a shared boundary.
   */
  it("gives every purchase its own clock rather than a shared reset", async () => {
    const first = await liveBlock(0, 0, "first");
    const second = await liveBlock(10, 10, "second");

    // Bought five hours ago, so it has 19 hours left of its 24.
    await pool.query(
      `INSERT INTO featured_slots (block_id, days, price_cents, starts_at, expires_at)
       VALUES ($1, 1, $2, now() - interval '5 hours',
               now() - interval '5 hours' + interval '1 day')`,
      [first, featuredPriceCents(1)],
    );
    // Bought just now, so it has the full 24.
    await featureBlock(pool, second, 1);

    const active = await activeFeatured(pool);
    const byHandle = new Map(active.map((row) => [row.handle, row]));

    const older = byHandle.get("first");
    const newer = byHandle.get("second");
    if (older === undefined || newer === undefined) throw new Error("both should be featured");

    expect(older.secondsRemaining / 3600).toBeGreaterThan(18.9);
    expect(older.secondsRemaining / 3600).toBeLessThan(19.1);
    expect(newer.secondsRemaining / 3600).toBeGreaterThan(23.9);

    // Five hours apart, exactly the gap between the two purchases.
    const gap = (newer.expiresAt.getTime() - older.expiresAt.getTime()) / 3_600_000;
    expect(gap).toBeGreaterThan(4.9);
    expect(gap).toBeLessThan(5.1);
  });

  it("honours a multi-day purchase", async () => {
    const block = await liveBlock(0, 0, "long");
    const slot = await featureBlock(pool, block, 10);

    const days = (slot.expiresAt.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(9.9);
    expect(days).toBeLessThan(10.1);
    expect(slot.priceCents).toBe(8200);
  });

  it("drops out of the column the moment its window closes", async () => {
    const block = await liveBlock(0, 0, "lapsed");
    await pool.query(
      `INSERT INTO featured_slots (block_id, days, price_cents, starts_at, expires_at)
       VALUES ($1, 1, $2, now() - interval '25 hours', now() - interval '1 hour')`,
      [block, featuredPriceCents(1)],
    );

    // No sweep runs: expiry is a read-time filter, so it is already gone.
    expect(await activeFeatured(pool)).toHaveLength(0);
  });

  it("lets one block hold several windows at once", async () => {
    const block = await liveBlock(0, 0, "double");
    await featureBlock(pool, block, 1);
    await featureBlock(pool, block, 3);

    const active = await activeFeatured(pool);
    expect(active).toHaveLength(2);
    expect(new Set(active.map((row) => row.id)).size).toBe(1);
  });

  it("refuses a day count outside the range, before touching the database", async () => {
    const block = await liveBlock(0, 0, "bad");
    await expect(featureBlock(pool, block, 11)).rejects.toBeInstanceOf(InvalidFeaturedDaysError);
    await expect(featureBlock(pool, block, 0)).rejects.toBeInstanceOf(InvalidFeaturedDaysError);
    expect(await activeFeatured(pool)).toHaveLength(0);
  });

  it("shows the newest purchases first, capped at the number of slots", async () => {
    for (let i = 0; i < 7; i += 1) {
      const block = await liveBlock(i * 3, 40, `creator${i}`);
      await featureBlock(pool, block, 1);
    }
    const active = await activeFeatured(pool);
    expect(active).toHaveLength(5);
    expect(active[0]?.handle).toBe("creator6");
  });
});
