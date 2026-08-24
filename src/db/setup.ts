import { readFile } from "node:fs/promises";
import { createPool } from "./client.js";

/** Applies db/schema.sql to DATABASE_URL. Idempotent: safe to re-run. */
async function main(): Promise<void> {
  const url = process.env["DATABASE_URL"];
  if (url === undefined || url === "") {
    throw new Error("DATABASE_URL is not set. See .env.example.");
  }

  const schema = await readFile(new URL("../../db/schema.sql", import.meta.url), "utf8");
  const pool = createPool(url);
  try {
    await pool.query(schema);
    console.log(`Applied db/schema.sql to ${new URL(url).pathname.replace(/^\//, "")}`);
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
