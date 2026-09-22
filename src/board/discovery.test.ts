import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { categoryCounts, isCategory, orbitAvailability, searchDirectory } from "./discovery.js";
import { ORBITS } from "../config.js";
import { createTestUser, hasDatabase, resetBoard, setupTestDatabase } from "../test/db.js";

const suite = describe.skipIf(!hasDatabase);

suite("directory and scarcity [requires DATABASE_URL]", () => {
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

  describe("scarcity", () => {
    it("reports an empty board as entirely free", async () => {
      const orbits = await orbitAvailability(pool);

      expect(orbits.map((o) => o.name)).toEqual(ORBITS.map((o) => o.name));
      for (const orbit of orbits) {
        expect(orbit.taken).toBe(0);
        expect(orbit.remaining).toBe(orbit.capacity);
        expect(orbit.capacity).toBeGreaterThan(0);
      }
    });

    // The counters are what a visitor is told before they spend money, so the
    // capacity they are measured against has to be the real geometry rather
    // than the area of the square the disc sits in.
    it("counts fewer tiles than the square board holds", async () => {
      const orbits = await orbitAvailability(pool);
      const total = orbits.reduce((sum, orbit) => sum + orbit.capacity, 0);

      expect(total).toBeLessThan(300 * 300);
      expect(total).toBeGreaterThan(60_000);
    });

    it("charges a claimed tile to the orbit it actually sits in", async () => {
      // Dead centre, so this is core ground and nothing else.
      await occupy(pool, alice, 150, 150);

      const orbits = await orbitAvailability(pool);
      const core = orbits.find((orbit) => orbit.name === "core");
      const outer = orbits.find((orbit) => orbit.name === "outer");

      expect(core?.taken).toBe(1);
      expect(core?.remaining).toBe((core?.capacity ?? 0) - 1);
      expect(outer?.taken).toBe(0);
    });

    it("counts a reservation as taken, because it is", async () => {
      await occupy(pool, alice, 150, 151, "reserved");

      const core = (await orbitAvailability(pool)).find((orbit) => orbit.name === "core");
      expect(core?.taken).toBe(1);
    });
  });

  describe("search", () => {
    it("finds a planet by a word in its description", async () => {
      await live(pool, alice, { handle: "nova", description: "Weekly essays on typography" });

      const page = await searchDirectory(pool, { text: "typography" });

      expect(page.total).toBe(1);
      expect(page.entries[0]?.handle).toBe("nova");
    });

    it("finds a planet by handle", async () => {
      await live(pool, alice, { handle: "nova" });
      expect((await searchDirectory(pool, { text: "nova" })).total).toBe(1);
    });

    // Fed straight from a text box, so it has to survive whatever is typed
    // into one rather than raising a syntax error at the database.
    it("survives punctuation a person would actually type", async () => {
      await live(pool, alice, { handle: "nova" });

      await expect(searchDirectory(pool, { text: 'what "is" this? & !' })).resolves.toMatchObject({
        total: 0,
      });
    });

    it("lists only live planets", async () => {
      await occupy(pool, alice, 150, 150, "reserved");
      expect((await searchDirectory(pool)).total).toBe(0);
    });

    it("filters by category and counts what is in each", async () => {
      await live(pool, alice, { handle: "nova", category: "music" });
      await live(pool, alice, { handle: "orion", category: "tech", x: 151 });

      expect((await searchDirectory(pool, { category: "music" })).total).toBe(1);
      expect(await categoryCounts(pool)).toEqual([
        { category: "music", count: 1 },
        { category: "tech", count: 1 },
      ]);
    });

    it("puts the bigger planet first", async () => {
      await live(pool, alice, { handle: "small", x: 150, size: 1 });
      await live(pool, alice, { handle: "big", x: 160, size: 4 });

      const page = await searchDirectory(pool);
      expect(page.entries.map((entry) => entry.handle)).toEqual(["big", "small"]);
    });

    it("pages without losing the total", async () => {
      await live(pool, alice, { handle: "one", x: 150 });
      await live(pool, alice, { handle: "two", x: 160 });

      const page = await searchDirectory(pool, { limit: 1, offset: 1 });
      expect(page.entries).toHaveLength(1);
      expect(page.total).toBe(2);
    });
  });

  it("recognises exactly the categories the database accepts", async () => {
    const result = await pool.query<{ value: string }>(
      `SELECT unnest(enum_range(NULL::planet_category))::text AS value`,
    );
    for (const row of result.rows) expect(isCategory(row.value)).toBe(true);
    expect(isCategory("crypto-hustle")).toBe(false);
  });
});

async function occupy(
  pool: Pool,
  userId: string,
  x: number,
  y: number,
  status: "reserved" | "live" = "reserved",
): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO blocks (user_id, x, y, size, status, reserved_until)
     VALUES ($1, $2, $3, 1, $4::block_status,
             CASE WHEN $4::text = 'reserved' THEN now() + interval '15 min' END)
     RETURNING id`,
    [userId, x, y, status],
  );
  const id = result.rows[0]?.id ?? "";
  await pool.query(`INSERT INTO occupied_tiles (x, y, block_id) VALUES ($1, $2, $3)`, [x, y, id]);
  return id;
}

interface LiveOptions {
  readonly handle: string;
  readonly description?: string;
  readonly category?: string;
  readonly x?: number;
  readonly size?: number;
}

async function live(pool: Pool, userId: string, options: LiveOptions): Promise<void> {
  await pool.query(
    `INSERT INTO blocks
       (user_id, x, y, size, status, published_at, image_url, display_name, handle,
        primary_url, description, category)
     VALUES ($1, $2, 150, $3, 'live', now(), 'https://cdn.example/a.webp', $4, $5,
             'https://example.com', $6, $7::planet_category)`,
    [
      userId,
      options.x ?? 150,
      options.size ?? 1,
      options.handle,
      options.handle,
      options.description ?? null,
      options.category ?? null,
    ],
  );
}
