import pg from "pg";
import type { Pool, PoolClient } from "pg";

const { Pool: PgPool, DatabaseError } = pg;

/** Anything a statement can run against: the pool, or a client inside a transaction. */
export type Queryable = Pool | PoolClient;

export function createPool(connectionString: string): Pool {
  return new PgPool({
    connectionString,
    // Claims are short transactions; a small pool with a hard statement cap
    // keeps a stuck claim from pinning connections.
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    statement_timeout: 10_000,
  });
}

/**
 * Runs fn inside BEGIN/COMMIT on a dedicated connection, rolling back on any
 * throw. Every claim goes through here; nothing writes tiles outside a
 * transaction.
 */
export async function withTransaction<T>(
  pool: Pool,
  fn: (tx: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // The connection may already be unusable; the original error is the one
      // worth reporting.
    }
    throw error;
  } finally {
    client.release();
  }
}

const UNIQUE_VIOLATION = "23505";

/** True when err is a duplicate-key violation on the occupied_tiles primary key. */
export function isTileCollision(error: unknown): boolean {
  return (
    error instanceof DatabaseError &&
    error.code === UNIQUE_VIOLATION &&
    error.constraint === "occupied_tiles_pkey"
  );
}

/**
 * Postgres reports the first duplicate key in the error detail, e.g.
 * `Key (x, y)=(12, 34) already exists.` It is one tile, not the full set, but
 * it is authoritative in a way the follow-up read is not.
 */
export function tileFromErrorDetail(error: unknown): { x: number; y: number } | null {
  if (!(error instanceof DatabaseError) || error.detail === undefined) return null;
  const match = /\(x,\s*y\)=\((\d+),\s*(\d+)\)/.exec(error.detail);
  if (match === null) return null;
  const [, rawX, rawY] = match;
  if (rawX === undefined || rawY === undefined) return null;
  return { x: Number(rawX), y: Number(rawY) };
}

export function isCheckViolation(error: unknown, constraint: string): boolean {
  return (
    error instanceof DatabaseError && error.code === "23514" && error.constraint === constraint
  );
}
