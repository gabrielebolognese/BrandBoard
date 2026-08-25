import { readFile } from "node:fs/promises";
import type { Pool } from "pg";
import { createPool } from "../db/client.js";

const SCHEMA_URL = new URL("../../db/schema.sql", import.meta.url);

export const DATABASE_URL = process.env["DATABASE_URL"] ?? "";

/**
 * The concurrency invariant is a property of PostgreSQL's unique index, so
 * these tests only mean anything against a real PostgreSQL. There is no mock
 * and no in-memory substitute: a fake that accepted both writers would pass
 * while the product was broken.
 */
export const hasDatabase = DATABASE_URL !== "";

/**
 * These tests TRUNCATE. Refuse to run against a database that is not obviously
 * disposable, unless someone has said out loud that it is.
 */
function assertDisposable(url: string): void {
  if (process.env["ALLOW_DESTRUCTIVE_TESTS"] === "1") return;

  const name = new URL(url).pathname.replace(/^\//, "");
  if (!/test/i.test(name)) {
    throw new Error(
      `Refusing to run destructive tests against database "${name}". ` +
        `Point DATABASE_URL at a database with "test" in its name, ` +
        `or set ALLOW_DESTRUCTIVE_TESTS=1 if you are certain.`,
    );
  }
}

/** Arbitrary constant; only has to be the same for everyone applying the schema. */
const SCHEMA_LOCK_ID = 0x4642_0001;

export async function setupTestDatabase(): Promise<Pool> {
  assertDisposable(DATABASE_URL);
  const pool = createPool(DATABASE_URL);
  const schema = await readFile(SCHEMA_URL, "utf8");

  // Two test files applying the schema at the same moment collide inside the
  // catalog (CREATE OR REPLACE FUNCTION is not concurrency-safe). Serialise it.
  const client = await pool.connect();
  try {
    await client.query(`SELECT pg_advisory_lock($1)`, [SCHEMA_LOCK_ID]);
    await client.query(schema);
  } finally {
    await client.query(`SELECT pg_advisory_unlock($1)`, [SCHEMA_LOCK_ID]).catch(() => undefined);
    client.release();
  }

  return pool;
}

/** Between tests: empty the board without dropping it. */
export async function resetBoard(pool: Pool): Promise<void> {
  await pool.query(
    `TRUNCATE featured_slots, click_events, occupied_tiles, blocks, users RESTART IDENTITY CASCADE`,
  );
}

export async function createTestUser(pool: Pool, handle: string): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO users (x_handle, x_user_id) VALUES ($1, $2) RETURNING id`,
    [handle, `x_${handle}`],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error("failed to create test user");
  return row.id;
}

export async function countTiles(pool: Pool): Promise<number> {
  const result = await pool.query<{ count: string }>(`SELECT count(*) FROM occupied_tiles`);
  return Number(result.rows[0]?.count ?? 0);
}

export async function tilesOf(pool: Pool, blockId: string): Promise<Array<{ x: number; y: number }>> {
  const result = await pool.query<{ x: number; y: number }>(
    `SELECT x, y FROM occupied_tiles WHERE block_id = $1 ORDER BY x, y`,
    [blockId],
  );
  return result.rows;
}

export async function statusOf(pool: Pool, blockId: string): Promise<string> {
  const result = await pool.query<{ status: string }>(`SELECT status FROM blocks WHERE id = $1`, [
    blockId,
  ]);
  const row = result.rows[0];
  if (row === undefined) throw new Error(`no block ${blockId}`);
  return row.status;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
