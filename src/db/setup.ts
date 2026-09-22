import { createPool, migrationUrl } from "./client.js";
import { appliedMigrations, migrate } from "./migrate.js";

/** Brings DATABASE_URL up to date. Safe to re-run: applied files are skipped. */
async function main(): Promise<void> {
  const url = migrationUrl();
  const pool = createPool(url, { max: 1, statementTimeoutMs: 120_000 });

  try {
    const { applied, alreadyApplied } = await migrate(pool, true);
    const name = new URL(url).pathname.replace(/^\//, "");

    if (applied.length === 0) {
      console.log(`${name} is up to date (${alreadyApplied} migrations applied).`);
    } else {
      console.log(`${name}: applied ${applied.length}, now at ${(await appliedMigrations(pool)).length}.`);
    }
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
