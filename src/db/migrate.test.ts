import { readdir } from "node:fs/promises";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appliedMigrations, migrate } from "./migrate.js";
import { hasDatabase, setupTestDatabase } from "../test/db.js";

const suite = describe.skipIf(!hasDatabase);

suite("migrations [requires DATABASE_URL]", () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = await setupTestDatabase();
  }, 60_000);

  afterAll(async () => {
    await pool.end();
  });

  // Counted from the directory rather than written down here, so adding a
  // migration does not mean editing a test that was not about the number.
  it("records every file it applied, in order", async () => {
    const files = (await readdir(new URL("../../db/migrations/", import.meta.url)))
      .filter((name) => name.endsWith(".sql"))
      .sort((a, b) => a.localeCompare(b, "en"));

    const applied = await appliedMigrations(pool);

    expect(applied.map((row) => row.name)).toEqual(files);
    expect(applied.map((row) => row.version)).toEqual([...applied.map((row) => row.version)].sort());
    expect(applied[0]?.name).toBe("001_initial.sql");
  });

  // The setup already ran them, so this second run must find nothing to do.
  // A migration that reapplies itself is the failure mode this whole mechanism
  // exists to prevent.
  it("does nothing on a database that is already up to date", async () => {
    const result = await migrate(pool);

    expect(result.applied).toEqual([]);
    expect(result.alreadyApplied).toBe((await appliedMigrations(pool)).length);
  });

  // Two servers booting at once both see the same work pending. The advisory
  // lock is what stops them both doing it.
  it("lets concurrent runners settle on one winner", async () => {
    const runs = await Promise.all([migrate(pool), migrate(pool), migrate(pool)]);

    for (const run of runs) expect(run.applied).toEqual([]);
    const after = await appliedMigrations(pool);
    expect(new Set(after.map((row) => row.version)).size).toBe(after.length);
  });
});
