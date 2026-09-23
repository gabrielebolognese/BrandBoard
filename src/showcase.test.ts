import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { fillShowcase } from "./showcase.js";
import { AURAS, ORBITS } from "./config.js";
import { hasDatabase, resetBoard, setupTestDatabase } from "./test/db.js";

/**
 * The showcase is the thing somebody presses to decide whether the product
 * looks like anything, and it runs a handful of bulk UPDATEs that no other test
 * touches. The first version of it shipped with a SQL syntax error in one of
 * them, which no amount of typechecking was going to find.
 */
const suite = describe.skipIf(!hasDatabase);

suite("filling the board [requires DATABASE_URL]", () => {
  let pool: Pool;
  let avatarDir: URL;
  let directory: string;

  beforeAll(async () => {
    pool = await setupTestDatabase();
  }, 30_000);

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await resetBoard(pool);
    directory = await mkdtemp(join(tmpdir(), "showcase-"));
    avatarDir = new URL(`${pathToFileURL(directory).href}/`);
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  // Small target: this claims through the real transaction and writes a real
  // avatar per planet, so a full board would make the suite crawl.
  const SMALL = 40;

  it("puts planets on the board", async () => {
    const filled = await fillShowcase(pool, avatarDir, SMALL);

    expect(filled.blocks).toBeGreaterThan(SMALL / 2);
    expect(filled.tiles).toBeGreaterThan(filled.blocks);
    expect(filled.anchors).toBe(ORBITS.length);
  });

  // The reason the button exists. A seeded board is entirely one colour,
  // because nothing sets an aura and the default is azure, and the halos then
  // read as a rendering artefact rather than as something somebody chose.
  it("spreads every aura across the board", async () => {
    await fillShowcase(pool, avatarDir, SMALL);

    const used = await pool.query<{ aura: string }>(
      `SELECT DISTINCT aura FROM blocks WHERE status = 'live'`,
    );
    const names = used.rows.map((row) => row.aura).sort();

    expect(names.length).toBeGreaterThan(1);
    for (const name of names) {
      expect(AURAS.map((aura) => aura.name)).toContain(name);
    }
  });

  it("puts one planet at each orbit's exact size cap", async () => {
    await fillShowcase(pool, avatarDir, SMALL);

    for (const orbit of ORBITS) {
      const anchor = await pool.query<{ size: number }>(
        `SELECT size FROM blocks WHERE handle = $1`,
        [{ core: "velamoreau", inner: "casperoyelaran", outer: "junovasquez" }[orbit.name] ?? ""],
      );
      expect(anchor.rows[0]?.size).toBe(orbit.maxSize);
    }
  });

  it("gives everything something for search to find", async () => {
    await fillShowcase(pool, avatarDir, SMALL);

    const bare = await pool.query<{ count: string }>(
      `SELECT count(*)::text FROM blocks WHERE status = 'live' AND description IS NULL`,
    );
    expect(Number(bare.rows[0]?.count)).toBe(0);

    const hit = await pool.query(
      `SELECT 1 FROM blocks
        WHERE status = 'live' AND search @@ websearch_to_tsquery('simple', 'synth')`,
    );
    expect(hit.rowCount).toBeGreaterThan(0);
  });

  it("varies the click counts, so the directory has an order", async () => {
    await fillShowcase(pool, avatarDir, SMALL);

    const spread = await pool.query<{ distinct: string; zero: string }>(
      `SELECT count(DISTINCT click_count)::text AS distinct,
              count(*) FILTER (WHERE click_count = 0)::text AS zero
         FROM blocks WHERE status = 'live'`,
    );
    expect(Number(spread.rows[0]?.distinct)).toBeGreaterThan(3);
    expect(Number(spread.rows[0]?.zero)).toBeLessThan(SMALL);
  });

  // Otherwise the only way to see the dead-link warning is to wait for
  // somebody's link to actually rot.
  it("leaves a few links visibly broken, and the rest healthy", async () => {
    await fillShowcase(pool, avatarDir, SMALL);

    const health = await pool.query<{ dead: string; unchecked: string }>(
      `SELECT count(*) FILTER (WHERE link_ok IS FALSE AND link_failures >= 3)::text AS dead,
              count(*) FILTER (WHERE link_ok IS NULL)::text AS unchecked
         FROM blocks WHERE status = 'live'`,
    );
    expect(Number(health.rows[0]?.dead)).toBe(3);
    expect(Number(health.rows[0]?.unchecked)).toBe(0);
  });

  // It is a button people press more than once, and a version that added to
  // what was there would drift further from a showcase every time.
  it("replaces the board rather than adding to it", async () => {
    const first = await fillShowcase(pool, avatarDir, SMALL);
    const second = await fillShowcase(pool, avatarDir, SMALL);

    expect(second.blocks).toBe(first.blocks);
    expect(second.anchors).toBe(ORBITS.length);

    const anchors = await pool.query<{ count: string }>(
      `SELECT count(*)::text FROM blocks WHERE handle = 'velamoreau'`,
    );
    expect(Number(anchors.rows[0]?.count)).toBe(1);
  });

  it("leaves no tile claimed twice, because it went through the real claim", async () => {
    await fillShowcase(pool, avatarDir, SMALL);

    const doubled = await pool.query<{ count: string }>(
      `SELECT count(*)::text FROM (
         SELECT x, y FROM occupied_tiles GROUP BY x, y HAVING count(*) > 1
       ) AS clashes`,
    );
    expect(Number(doubled.rows[0]?.count)).toBe(0);
  });
});
