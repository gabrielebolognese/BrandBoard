/**
 * Boots a throwaway PostgreSQL, runs a command against it, tears it down.
 *
 *   node scripts/with-postgres.mjs npx tsx src/dev-server.ts
 *
 * Exists so the board and the claim concurrency tests are runnable with no
 * Docker and no system PostgreSQL. CI with a service container can skip this
 * and set DATABASE_URL directly.
 */
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";

const DATABASE = "flashbrand_test";

const command = process.argv.slice(2);
if (command.length === 0) {
  console.error("usage: node scripts/with-postgres.mjs <command> [args...]");
  process.exit(2);
}

/**
 * Ask the OS for a free port rather than guessing one. A hard kill of a
 * previous run can leave its postgres holding a fixed port, and a dev server
 * that cannot start because of last week's orphan is a bad dev server.
 */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

const port = Number(process.env.EMBEDDED_PG_PORT ?? (await freePort()));
const dataDir = await mkdtemp(join(tmpdir(), "flashbrand-pg-"));
const postgres = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: "postgres",
  password: "postgres",
  port,
  persistent: false,
});

let stopped = false;
async function shutdown() {
  if (stopped) return;
  stopped = true;
  await postgres.stop().catch(() => {});
  await rm(dataDir, { recursive: true, force: true }).catch(() => {});
}

// A kill of this process must not leave a postgres behind holding a port.
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"]) {
  process.on(signal, () => {
    void shutdown().then(() => process.exit(0));
  });
}

let exitCode = 1;
try {
  console.log(`Starting embedded PostgreSQL on port ${port}...`);
  await postgres.initialise();
  await postgres.start();
  await postgres.createDatabase(DATABASE);

  const url = `postgres://postgres:postgres@localhost:${port}/${DATABASE}`;
  console.log(`Running: ${command.join(" ")}\n`);

  exitCode = await new Promise((resolve) => {
    const child = spawn(command[0], command.slice(1), {
      stdio: "inherit",
      shell: process.platform === "win32",
      env: { ...process.env, DATABASE_URL: url },
    });
    const forward = (signal) => () => child.kill(signal);
    process.on("SIGINT", forward("SIGINT"));
    process.on("SIGTERM", forward("SIGTERM"));

    child.on("close", (code) => resolve(code ?? 1));
    child.on("error", (error) => {
      console.error(error);
      resolve(1);
    });
  });
} catch (error) {
  console.error("embedded PostgreSQL failed to start:", error);
  exitCode = 1;
} finally {
  await shutdown();
}

process.exit(exitCode);
