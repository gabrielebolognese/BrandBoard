import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { changeBlock, changeHistory, classifyChange, quoteChange } from "./resize.js";
import { claimBlock } from "./claim.js";
import { ORBITS, monthlyPriceCents } from "../config.js";
import {
  countTiles,
  createTestUser,
  hasDatabase,
  resetBoard,
  setupTestDatabase,
  tilesOf,
} from "../test/db.js";

describe("classifying a change", () => {
  it("calls a same-size relocation a move", () => {
    expect(classifyChange({ x: 150, y: 150, size: 2 }, { x: 160, y: 160, size: 2 })).toBe("move");
  });

  it("calls keeping the ground and taking more a grow", () => {
    expect(classifyChange({ x: 150, y: 150, size: 2 }, { x: 150, y: 150, size: 4 })).toBe("grow");
  });

  it("lets a grow expand up and to the left", () => {
    expect(classifyChange({ x: 150, y: 150, size: 2 }, { x: 149, y: 149, size: 4 })).toBe("grow");
  });

  // A grow that also relocates is a move and a grow at once. They price
  // differently and fail differently, so it is refused rather than guessed at.
  it("refuses a grow that abandons the ground it had", () => {
    expect(() => classifyChange({ x: 150, y: 150, size: 2 }, { x: 170, y: 170, size: 4 })).toThrow(
      /keep the ground/,
    );
  });

  it("refuses to shrink", () => {
    expect(() => classifyChange({ x: 150, y: 150, size: 4 }, { x: 150, y: 150, size: 2 })).toThrow(
      /cannot be made smaller/,
    );
  });

  it("refuses a change that changes nothing", () => {
    expect(() => classifyChange({ x: 150, y: 150, size: 2 }, { x: 150, y: 150, size: 2 })).toThrow(
      /already is/,
    );
  });
});

describe("quoting a change", () => {
  it("charges the difference between the two squares", () => {
    const quote = quoteChange({ x: 150, y: 150, size: 1 }, { x: 150, y: 150, size: 2 });

    expect(quote.monthlyCentsBefore).toBe(monthlyPriceCents(150, 150, 1));
    expect(quote.monthlyCentsAfter).toBe(monthlyPriceCents(150, 150, 2));
    expect(quote.monthlyDeltaCents).toBe(quote.monthlyCentsAfter - quote.monthlyCentsBefore);
    expect(quote.monthlyDeltaCents).toBeGreaterThan(0);
  });

  // Moving in from the cheap ground to the expensive ground is the whole point
  // of offering a move, so the delta has to reflect the orbit and not the size.
  it("prices a move inward as an increase at the same size", () => {
    const outer = ORBITS[2];
    const quote = quoteChange({ x: 250, y: 150, size: 2 }, { x: 150, y: 150, size: 2 });

    expect(outer?.name).toBe("outer");
    expect(quote.kind).toBe("move");
    expect(quote.tilesBefore).toBe(quote.tilesAfter);
    expect(quote.monthlyDeltaCents).toBeGreaterThan(0);
  });

  it("owes the buyer when the new ground is cheaper", () => {
    const quote = quoteChange({ x: 150, y: 150, size: 2 }, { x: 250, y: 150, size: 2 });
    expect(quote.monthlyDeltaCents).toBeLessThan(0);
  });

  it("refuses a destination the orbit will not take", () => {
    // The outer reach takes six, and this asks for nine.
    expect(() => quoteChange({ x: 250, y: 150, size: 6 }, { x: 250, y: 150, size: 9 })).toThrow(
      /takes planets up to/,
    );
  });

  it("refuses a destination out in the void", () => {
    expect(() => quoteChange({ x: 150, y: 150, size: 2 }, { x: 5, y: 5, size: 2 })).toThrow(
      /outside the universe/,
    );
  });
});

const suite = describe.skipIf(!hasDatabase);

suite("growing and moving [requires DATABASE_URL]", () => {
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

  it("grows a planet and keeps every tile it already had", async () => {
    const block = await livePlanet(pool, alice, { x: 150, y: 150, size: 2 });

    const change = await changeBlock(pool, alice, block, { x: 150, y: 150, size: 3 });

    expect(change.kind).toBe("grow");
    const tiles = await tilesOf(pool, block);
    expect(tiles).toHaveLength(9);
    expect(tiles).toContainEqual({ x: 150, y: 150 });
    expect(tiles).toContainEqual({ x: 152, y: 152 });
    expect(await squareOf(pool, block)).toEqual({ x: 150, y: 150, size: 3 });
  });

  it("moves a planet, giving up the ground it leaves", async () => {
    const block = await livePlanet(pool, alice, { x: 250, y: 150, size: 2 });

    await changeBlock(pool, alice, block, { x: 150, y: 150, size: 2 });

    const tiles = await tilesOf(pool, block);
    expect(tiles).toHaveLength(4);
    expect(tiles).toContainEqual({ x: 150, y: 150 });
    expect(await countTiles(pool)).toBe(4);

    const left = await pool.query(`SELECT 1 FROM occupied_tiles WHERE x = 250 AND y = 150`);
    expect(left.rowCount).toBe(0);
  });

  it("lets a move overlap where it already was", async () => {
    const block = await livePlanet(pool, alice, { x: 150, y: 150, size: 3 });

    await changeBlock(pool, alice, block, { x: 151, y: 151, size: 3 });

    expect(await tilesOf(pool, block)).toHaveLength(9);
    expect(await countTiles(pool)).toBe(9);
  });

  it("records what changed and what it changed the bill to", async () => {
    const block = await livePlanet(pool, alice, { x: 150, y: 150, size: 1 });

    await changeBlock(pool, alice, block, { x: 150, y: 150, size: 2 });

    const history = await changeHistory(pool, block);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      kind: "grow",
      from: { x: 150, y: 150, size: 1 },
      to: { x: 150, y: 150, size: 2 },
    });
    expect(history[0]?.monthlyDeltaCents).toBeGreaterThan(0);
  });

  // The one that matters. A grow is a claim, and a claim that collides has to
  // lose completely rather than halfway.
  it("refuses a grow onto someone else's tile and changes nothing", async () => {
    const mine = await livePlanet(pool, alice, { x: 150, y: 150, size: 2 });
    await claimBlock(pool, bob, { x: 152, y: 152, size: 1 });

    await expect(changeBlock(pool, alice, mine, { x: 150, y: 150, size: 3 })).rejects.toMatchObject({
      code: "tile_conflict",
      status: 409,
    });

    expect(await squareOf(pool, mine)).toEqual({ x: 150, y: 150, size: 2 });
    expect(await tilesOf(pool, mine)).toHaveLength(4);
  });

  // A failed move deletes its old tiles and rolls back. If the rollback did not
  // put them back, a collision would cost someone the square they already had.
  it("keeps its old square when a move collides", async () => {
    const mine = await livePlanet(pool, alice, { x: 250, y: 150, size: 2 });
    await claimBlock(pool, bob, { x: 150, y: 150, size: 2 });

    await expect(changeBlock(pool, alice, mine, { x: 150, y: 150, size: 2 })).rejects.toMatchObject({
      code: "tile_conflict",
    });

    expect(await squareOf(pool, mine)).toEqual({ x: 250, y: 150, size: 2 });
    expect(await tilesOf(pool, mine)).toEqual([
      { x: 250, y: 150 },
      { x: 250, y: 151 },
      { x: 251, y: 150 },
      { x: 251, y: 151 },
    ]);
  });

  it("does not let one person move another person's planet", async () => {
    const hers = await livePlanet(pool, alice, { x: 150, y: 150, size: 1 });

    await expect(changeBlock(pool, bob, hers, { x: 160, y: 160, size: 1 })).rejects.toMatchObject({
      code: "not_your_block",
      status: 403,
    });
  });

  it("says a planet that is not there is not there", async () => {
    await expect(
      changeBlock(pool, alice, "00000000-0000-0000-0000-000000000000", {
        x: 150,
        y: 150,
        size: 1,
      }),
    ).rejects.toMatchObject({ code: "unknown_block", status: 404 });
  });

  it("refuses to change a planet that has not been paid for", async () => {
    const reserved = await claimBlock(pool, alice, { x: 150, y: 150, size: 1 });

    await expect(
      changeBlock(pool, alice, reserved.id, { x: 150, y: 150, size: 2 }),
    ).rejects.toMatchObject({ code: "block_not_changeable", status: 409 });
  });

  it("holds a grow to the cap of the ground it is standing on", async () => {
    const block = await livePlanet(pool, alice, { x: 250, y: 150, size: 6 });

    await expect(changeBlock(pool, alice, block, { x: 250, y: 150, size: 7 })).rejects.toMatchObject(
      { code: "size_not_allowed_here" },
    );
  });

  // Two transactions racing for the same square, one of them a grow. The
  // primary key decides it, exactly as it does for two first purchases.
  it("lets exactly one of a grow and a claim win the same tile", async () => {
    const mine = await livePlanet(pool, alice, { x: 150, y: 150, size: 2 });

    const results = await Promise.allSettled([
      changeBlock(pool, alice, mine, { x: 150, y: 150, size: 3 }),
      claimBlock(pool, bob, { x: 152, y: 152, size: 1 }),
    ]);

    const won = results.filter((result) => result.status === "fulfilled");
    expect(won).toHaveLength(1);

    const holder = await pool.query<{ block_id: string }>(
      `SELECT block_id FROM occupied_tiles WHERE x = 152 AND y = 152`,
    );
    expect(holder.rowCount).toBe(1);
  });

  it("survives the same race repeatedly", async () => {
    for (let round = 0; round < 8; round += 1) {
      await resetBoard(pool);
      alice = await createTestUser(pool, `alice${round}`);
      bob = await createTestUser(pool, `bob${round}`);
      const mine = await livePlanet(pool, alice, { x: 150, y: 150, size: 2 });

      const results = await Promise.allSettled([
        changeBlock(pool, alice, mine, { x: 150, y: 150, size: 3 }),
        claimBlock(pool, bob, { x: 152, y: 152, size: 1 }),
      ]);

      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    }
  }, 30_000);
});

async function livePlanet(
  pool: Pool,
  userId: string,
  at: { x: number; y: number; size: number },
): Promise<string> {
  const block = await claimBlock(pool, userId, at);
  await pool.query(
    `UPDATE blocks
        SET status = 'live', reserved_until = NULL, published_at = now(),
            image_url = 'https://cdn.example/a.webp', display_name = 'A Creator',
            handle = $2, primary_url = 'https://example.com'
      WHERE id = $1`,
    [block.id, `h${block.id.slice(0, 8)}`],
  );
  return block.id;
}

async function squareOf(
  pool: Pool,
  blockId: string,
): Promise<{ x: number; y: number; size: number }> {
  const result = await pool.query<{ x: number; y: number; size: number }>(
    `SELECT x, y, size FROM blocks WHERE id = $1`,
    [blockId],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error("no such block");
  return row;
}
