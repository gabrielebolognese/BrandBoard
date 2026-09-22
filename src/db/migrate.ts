import { readFile, readdir } from "node:fs/promises";
import type { Pool } from "pg";

/**
 * Schema migrations.
 *
 * Until now the whole schema was one file re-applied on every boot, held
 * together by CREATE TABLE IF NOT EXISTS and a growing tail of ALTER blocks
 * wrapped in exception handlers. That works while every database is a throwaway
 * and stops working the moment one holds data: there is no way to know what has
 * been applied, no way to apply something exactly once, and no way to tell an
 * old database from a new one.
 *
 * So: numbered files, applied in order, each recorded and each inside its own
 * transaction. A migration that fails leaves nothing behind and nothing marked.
 */

const MIGRATIONS = new URL("../../db/migrations/", import.meta.url);

/**
 * Only one process may migrate at a time.
 *
 * Two servers booting together would otherwise both see a migration as pending
 * and both try to apply it. The lock is held for the whole run and released by
 * the session ending, so a crash mid-migration does not leave it stuck.
 */
const MIGRATION_LOCK = 0x4253_0001;

export interface AppliedMigration {
  readonly version: string;
  readonly name: string;
  readonly appliedAt: Date;
}

export interface MigrationResult {
  readonly applied: string[];
  readonly alreadyApplied: number;
}

export async function migrate(pool: Pool, log = false): Promise<MigrationResult> {
  const files = (await readdir(MIGRATIONS))
    .filter((name) => name.endsWith(".sql"))
    .sort((a, b) => a.localeCompare(b, "en"));

  const client = await pool.connect();
  const applied: string[] = [];

  try {
    await client.query(`SELECT pg_advisory_lock($1)`, [MIGRATION_LOCK]);
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         version    text PRIMARY KEY,
         name       text NOT NULL,
         applied_at timestamptz NOT NULL DEFAULT now()
       )`,
    );

    const done = await client.query<{ version: string }>(`SELECT version FROM schema_migrations`);
    const have = new Set(done.rows.map((row) => row.version));

    for (const file of files) {
      const version = versionOf(file);
      if (have.has(version)) continue;

      const sql = await readFile(new URL(file, MIGRATIONS), "utf8");

      // Each migration is all or nothing. Postgres runs DDL transactionally, so
      // a failure halfway through leaves the schema exactly as it was.
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query(`INSERT INTO schema_migrations (version, name) VALUES ($1, $2)`, [
          version,
          file,
        ]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw new Error(`migration ${file} failed: ${describe(error)}`, { cause: error });
      }

      applied.push(file);
      if (log) console.log(`  applied ${file}`);
    }

    return { applied, alreadyApplied: have.size };
  } finally {
    await client.query(`SELECT pg_advisory_unlock($1)`, [MIGRATION_LOCK]).catch(() => undefined);
    client.release();
  }
}

/** What has run, for a health endpoint or a support question. */
export async function appliedMigrations(pool: Pool): Promise<AppliedMigration[]> {
  const result = await pool.query<{ version: string; name: string; applied_at: Date }>(
    `SELECT version, name, applied_at FROM schema_migrations ORDER BY version`,
  );
  return result.rows.map((row) => ({
    version: row.version,
    name: row.name,
    appliedAt: row.applied_at,
  }));
}

/** `003_whatever.sql` is version `003`, so a file can be renamed but not renumbered. */
function versionOf(file: string): string {
  const match = /^(\d+)/.exec(file);
  if (match?.[1] === undefined) {
    throw new Error(`migration ${file} does not start with a number`);
  }
  return match[1];
}

function describe(error: unknown): string {
  if (typeof error !== "object" || error === null) return String(error);
  const { message, detail, hint } = error as Record<string, unknown>;
  return [message, detail, hint].filter((part) => typeof part === "string").join(" | ");
}
