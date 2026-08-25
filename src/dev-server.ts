import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import type { Pool } from "pg";
import { claimBlocks } from "./board/claim.js";
import { runReservationSweep } from "./board/cleanup.js";
import { getCompositeBoard, invalidateCompositeBoard, localAvatarStore } from "./board/composite.js";
import { ClaimError, TileConflictError } from "./board/errors.js";
import { isValidSize } from "./board/geometry.js";
import type { Placement } from "./board/geometry.js";
import { createCheckout, readCheckout } from "./board/checkout.js";
import { InvalidFeaturedDaysError, activeFeatured, featureBlock } from "./board/featured.js";
import { availabilityBitmap, buildManifest, heldTileCount } from "./board/manifest.js";
import { currentlyWatching, startWatchingTicker } from "./board/watching.js";
import {
  BILLING_PERIOD,
  BOARD_SIZE,
  FEATURED_MAX_DAYS,
  FEATURED_MIN_DAYS,
  FEATURED_SLOTS,
  MAX_BLOCK_SIZE,
  TILE_COUNT,
  TILE_INSET,
  TILE_PIXELS,
  featuredPriceCents,
  isValidFeaturedDays,
  monthlyPriceCents,
  pricePerTileCentsPerMonth,
} from "./config.js";
import { createPool } from "./db/client.js";
import { seedBoard } from "./seed.js";

/**
 * Development harness. It serves the board so the rendering work can be looked
 * at before a frontend framework is chosen; the routing here is throwaway, but
 * everything it calls into (manifest, composite, claim) is not.
 */

const PUBLIC_DIR = new URL("../public/", import.meta.url);
const AVATAR_DIR = new URL("../var/avatars/", import.meta.url);
const SCHEMA_FILE = new URL("../db/schema.sql", import.meta.url);

/**
 * Until a real price is chosen, the UI shows this and says it is a placeholder.
 * Cents per tile per month.
 */
const PLACEHOLDER_RATE_CENTS = 200;

const url = process.env["DATABASE_URL"];
if (url === undefined || url === "") {
  console.error(
    "DATABASE_URL is not set.\n" +
      "  npm run dev     starts a throwaway PostgreSQL and this server together\n" +
      "  npm run serve   uses an existing DATABASE_URL",
  );
  process.exit(1);
}

const pool = createPool(url);
const databaseName = new URL(url).pathname.replace(/^\//, "");

// If the throwaway database goes away, so does this server. Otherwise a killed
// run leaves a process still holding the port and answering every request with
// an error, which is worse than not being there at all.
pool.on("error", (error) => {
  console.error("lost the database, shutting down:", error.message);
  process.exit(1);
});
const resettable = /test|dev/i.test(databaseName);
const avatars = localAvatarStore(AVATAR_DIR);

await pool.query(await readFile(SCHEMA_FILE, "utf8"));
const devUserId = await ensureDevUser(pool);

// Seed on an empty board so `npm run dev` always shows something.
if ((await heldTileCount(pool)) === 0) {
  process.stdout.write("seeding fake listings... ");
  const seeded = await seedBoard(pool, AVATAR_DIR);
  console.log(`${seeded.blocks} blocks, ${seeded.tiles} tiles`);
}

process.stdout.write("rendering composite board... ");
const initial = await getCompositeBoard(pool, avatars);
console.log(`${(initial.webp.length / 1024).toFixed(0)}KB webp, ${initial.blocks} avatars`);

startWatchingTicker();

const server = createServer((req, res) => {
  void handle(req, res).catch((error: unknown) => {
    console.error(error);
    if (!res.headersSent) sendJson(res, 500, { error: "internal_error" });
  });
});

const port = await listenOnFreePort(server, Number(process.env["PORT"] ?? 4310));
console.log(`\n  FlashBrand  ->  http://localhost:${port}\n`);
console.log(`  database ${databaseName}   board ${BOARD_SIZE}x${BOARD_SIZE}   dev user ${devUserId}\n`);

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const requestUrl = new URL(req.url ?? "/", `http://localhost:${port}`);
  const path = requestUrl.pathname;
  const method = req.method ?? "GET";

  if (method === "GET") {
    if (path === "/") return sendFile(res, new URL("index.html", PUBLIC_DIR));

    const asset = /^\/([\w.-]+\.(?:js|css))$/.exec(path);
    if (asset?.[1] !== undefined) return sendFile(res, new URL(basename(asset[1]), PUBLIC_DIR));

    if (path === "/board.webp") return sendCompositeBoard(req, res);
    if (path === "/api/manifest") return sendManifest(req, res);
    if (path === "/api/availability") return sendAvailability(res);
    if (path === "/api/featured") return sendJson(res, 200, await featured(pool));
    if (path === "/api/stats") return sendJson(res, 200, await stats(pool));
    if (path === "/api/board") return sendJson(res, 200, await boardState(pool));

    const avatar = /^\/avatars\/([\w.-]+)$/.exec(path);
    if (avatar?.[1] !== undefined) {
      return sendFile(res, new URL(basename(avatar[1]), AVATAR_DIR));
    }

    const block = /^\/api\/block\/([0-9a-f-]{36})$/.exec(path);
    if (block?.[1] !== undefined) return sendBlockDetail(res, block[1]);

    const session = /^\/api\/checkout\/(chk_[0-9a-f-]{36})$/.exec(path);
    if (session?.[1] !== undefined) {
      return sendJson(res, 200, { id: session[1], blocks: await readCheckout(pool, session[1]) });
    }

    if (path === "/api/featured/quote") {
      const days = Number(requestUrl.searchParams.get("days") ?? "1");
      if (!isValidFeaturedDays(days)) {
        return sendJson(res, 400, {
          error: "invalid_featured_days",
          message: `Featuring runs from ${FEATURED_MIN_DAYS} to ${FEATURED_MAX_DAYS} days.`,
        });
      }
      return sendJson(res, 200, {
        days,
        priceCents: featuredPriceCents(days),
        // One-off, unlike tile rent. Buying more days does not renew anything.
        recurring: false,
      });
    }

    if (path === "/api/quote") {
      const size = Number(requestUrl.searchParams.get("size") ?? "1");
      // Refuse to price something nobody can buy: a quote for a 26x26 would be
      // a number the checkout could never honour.
      if (!isValidSize(size)) {
        return sendJson(res, 400, {
          error: "invalid_size",
          message: `Blocks run from 1x1 to ${MAX_BLOCK_SIZE}x${MAX_BLOCK_SIZE}.`,
          maxBlockSize: MAX_BLOCK_SIZE,
        });
      }
      return sendJson(res, 200, quote(size));
    }
  }

  if (method === "POST") {
    if (path === "/api/claim") return claim(req, res);
    if (path === "/api/checkout") return checkout(req, res);
    if (path === "/api/featured") return buyFeatured(req, res);

    const pay = /^\/api\/checkout\/(chk_[0-9a-f-]{36})\/pay$/.exec(path);
    if (pay?.[1] !== undefined) return payCheckout(res, pay[1]);
    if (path === "/api/sweep") return sendJson(res, 200, await runReservationSweep(pool));
    if (path === "/api/reset") {
      if (!resettable) return sendJson(res, 403, { error: "not_a_dev_database", databaseName });
      await pool.query(`TRUNCATE click_events, occupied_tiles, blocks RESTART IDENTITY CASCADE`);
      invalidateCompositeBoard();
      return sendJson(res, 200, { reset: true });
    }
  }

  return sendJson(res, 404, { error: "not_found", route: `${method} ${path}` });
}

// ---------------------------------------------------------------------------
// Board
// ---------------------------------------------------------------------------

async function sendCompositeBoard(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const board = await getCompositeBoard(pool, avatars);
  const etag = `"board-${board.version}"`;

  if (req.headers["if-none-match"] === etag) {
    res.writeHead(304, { etag }).end();
    return;
  }

  res.writeHead(200, {
    "content-type": "image/webp",
    "content-length": board.webp.length,
    etag,
    // Immutable per version: publishing a block changes the version, not this.
    "cache-control": "public, max-age=60",
  });
  res.end(board.webp);
}

async function sendManifest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const manifest = await buildManifest(pool);
  const etag = `"manifest-${manifest.version}"`;

  if (req.headers["if-none-match"] === etag) {
    res.writeHead(304, { etag }).end();
    return;
  }
  sendJson(res, 200, manifest, { etag, "cache-control": "public, max-age=30" });
}

async function sendAvailability(res: ServerResponse): Promise<void> {
  const bitmap = await availabilityBitmap(pool);
  // Advisory only: hover feedback. The claim transaction remains the authority.
  sendJson(res, 200, {
    boardSize: BOARD_SIZE,
    bits: bitmap.toString("base64"),
    heldTiles: countBits(bitmap),
  });
}

async function sendBlockDetail(res: ServerResponse, id: string): Promise<void> {
  const result = await pool.query(
    `SELECT id, x, y, size, display_name AS name, handle, primary_url AS url,
            image_url, category, links, click_count, published_at
       FROM blocks
      WHERE id = $1 AND status = 'live'`,
    [id],
  );
  const row = result.rows[0];
  if (row === undefined) return sendJson(res, 404, { error: "not_found" });
  sendJson(res, 200, row);
}

/**
 * The blocks the left column shows: the featured windows that are open right
 * now, newest purchase first. Each carries its own remaining time, because each
 * was bought on its own clock.
 */
async function featured(pool: Pool): Promise<unknown> {
  return {
    slots: FEATURED_SLOTS,
    blocks: await activeFeatured(pool),
  };
}

async function stats(pool: Pool): Promise<unknown> {
  const held = await heldTileCount(pool);
  const rows = await pool.query<{ live: string; clicks: string }>(
    `SELECT count(*) FILTER (WHERE status = 'live')::text AS live,
            coalesce(sum(click_count), 0)::text AS clicks
       FROM blocks`,
  );
  return {
    tilesTotal: TILE_COUNT,
    tilesAvailable: TILE_COUNT - held,
    blocksLive: Number(rows.rows[0]?.live ?? 0),
    clicksDelivered: Number(rows.rows[0]?.clicks ?? 0),
    watching: currentlyWatching(),
    tilePixels: TILE_PIXELS,
    tileInset: TILE_INSET,
    boardSize: BOARD_SIZE,
    maxBlockSize: MAX_BLOCK_SIZE,
    // For displaying a running total while a block is being dragged. The price
    // actually charged is still computed server side at checkout, never sent up.
    pricePerTileCentsPerMonth: tileRate().cents,
    priceIsPlaceholder: tileRate().placeholder,
    billingPeriod: BILLING_PERIOD,
  };
}

async function boardState(pool: Pool): Promise<unknown> {
  const blocks = await pool.query(
    `SELECT b.id, b.x, b.y, b.size, b.status, b.reserved_until,
            count(t.block_id)::int AS tiles
       FROM blocks b
       LEFT JOIN occupied_tiles t ON t.block_id = b.id
      GROUP BY b.id
      ORDER BY b.created_at DESC
      LIMIT 50`,
  );
  const held = await heldTileCount(pool);
  return { tilesHeld: held, tilesAvailable: TILE_COUNT - held, recent: blocks.rows };
}

// ---------------------------------------------------------------------------
// Claiming
// ---------------------------------------------------------------------------

/**
 * The per-tile monthly rate, falling back to the dev placeholder when none is
 * set. config.ts still refuses to invent a price; the fallback lives here, in
 * the dev harness, and every response says which one it used.
 */
function tileRate(): { cents: number; placeholder: boolean } {
  try {
    return { cents: pricePerTileCentsPerMonth(), placeholder: false };
  } catch {
    return { cents: PLACEHOLDER_RATE_CENTS, placeholder: true };
  }
}

function quote(size: number): unknown {
  try {
    return {
      size,
      tiles: size * size,
      monthlyCents: monthlyPriceCents(size),
      billingPeriod: BILLING_PERIOD,
      placeholder: false,
    };
  } catch {
    return {
      size,
      tiles: size * size,
      monthlyCents: size * size * PLACEHOLDER_RATE_CENTS,
      billingPeriod: BILLING_PERIOD,
      placeholder: true,
      note: "PRICE_PER_TILE_CENTS_PER_MONTH is unset; this is a dev placeholder.",
    };
  }
}

/**
 * Cart to checkout. Reserves every square in one transaction, then prices what
 * it managed to hold. Returns 409 with the offending tiles if any square in the
 * cart was taken, and nothing is reserved in that case.
 */
async function checkout(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let placements: Placement[];
  try {
    const body = (await readJson(req)) as { placements?: unknown };
    placements = parsePlacements(body.placements);
  } catch (error) {
    return sendJson(res, 400, { error: "bad_request", detail: String(error) });
  }

  const rate = tileRate();
  try {
    const session = await createCheckout(pool, devUserId, placements, rate.cents, {
      rateIsPlaceholder: rate.placeholder,
    });
    return sendJson(res, 201, session);
  } catch (error) {
    if (error instanceof TileConflictError) {
      return sendJson(res, error.status, {
        error: error.code,
        message: error.message,
        conflictCount: error.conflictCount,
        conflicts: error.conflicts,
      });
    }
    if (error instanceof ClaimError) {
      return sendJson(res, error.status, { error: error.code, message: error.message });
    }
    throw error;
  }
}

/**
 * The buy button's endpoint.
 *
 * Everything a real payment needs is in place: the order exists, the tiles are
 * held, and the amount is known. The only missing piece is the provider, so
 * this answers 503 rather than pretending. When Paddle is wired up, this is
 * where the transaction is created and a redirect URL comes back.
 */
async function payCheckout(res: ServerResponse, checkoutId: string): Promise<void> {
  const blocks = await readCheckout(pool, checkoutId);

  if (blocks.length === 0) {
    return sendJson(res, 404, { error: "unknown_checkout", message: "No such order." });
  }

  const stillHeld = blocks.some(
    (block) =>
      block.status === "reserved" &&
      block.reservedUntil !== null &&
      block.reservedUntil.getTime() > Date.now(),
  );

  if (!stillHeld) {
    return sendJson(res, 410, {
      error: "hold_expired",
      message: "The hold on those tiles expired and they went back on sale.",
    });
  }

  return sendJson(res, 503, {
    error: "payment_provider_not_configured",
    provider: "paddle",
    message:
      "Paddle is not connected yet, so no charge was attempted. The order is valid and " +
      "the tiles stay held until the reservation lapses.",
    checkoutId,
    blocks: blocks.length,
  });
}

/** Buys a featured window for a block. The clock starts now, not at midnight. */
async function buyFeatured(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let blockId: string;
  let days: number;
  try {
    const body = (await readJson(req)) as { blockId?: unknown; days?: unknown };
    if (typeof body.blockId !== "string" || typeof body.days !== "number") {
      throw new Error("expected blockId and days");
    }
    blockId = body.blockId;
    days = body.days;
  } catch (error) {
    return sendJson(res, 400, { error: "bad_request", detail: String(error) });
  }

  try {
    const slot = await featureBlock(pool, blockId, days);
    return sendJson(res, 201, {
      ...slot,
      days,
      // Paddle is not wired, so nothing was charged for this either.
      charged: false,
    });
  } catch (error) {
    if (error instanceof InvalidFeaturedDaysError) {
      return sendJson(res, error.status, { error: error.code, message: error.message });
    }
    throw error;
  }
}

async function claim(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let placements: Placement[];
  try {
    const body = (await readJson(req)) as { placements?: unknown };
    placements = parsePlacements(body.placements);
  } catch (error) {
    return sendJson(res, 400, { error: "bad_request", detail: String(error) });
  }

  try {
    const blocks = await claimBlocks(pool, devUserId, placements);
    return sendJson(res, 201, { claimed: blocks });
  } catch (error) {
    if (error instanceof TileConflictError) {
      return sendJson(res, error.status, {
        error: error.code,
        message: error.message,
        conflictCount: error.conflictCount,
        conflicts: error.conflicts,
      });
    }
    if (error instanceof ClaimError) {
      return sendJson(res, error.status, { error: error.code, message: error.message });
    }
    throw error;
  }
}

function parsePlacements(input: unknown): Placement[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw new Error("expected a non-empty placements array");
  }
  return input.map((raw) => {
    const { x, y, size } = raw as Record<string, unknown>;
    if (typeof x !== "number" || typeof y !== "number" || typeof size !== "number") {
      throw new Error("each placement needs numeric x, y and size");
    }
    return { x, y, size };
  });
}

// ---------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".webp": "image/webp",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

async function sendFile(res: ServerResponse, file: URL): Promise<void> {
  try {
    const body = await readFile(file);
    res.writeHead(200, {
      "content-type": MIME[extname(file.pathname)] ?? "application/octet-stream",
      "content-length": body.length,
      "cache-control": "no-cache",
    });
    res.end(body);
  } catch {
    sendJson(res, 404, { error: "not_found", file: basename(file.pathname) });
  }
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
    ...headers,
  });
  res.end(payload);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (raw.trim() === "") return {};
  return JSON.parse(raw) as Record<string, unknown>;
}

function countBits(buffer: Buffer): number {
  let total = 0;
  for (const byte of buffer) {
    let b = byte;
    while (b !== 0) {
      total += b & 1;
      b >>= 1;
    }
  }
  return total;
}

/**
 * Port 3000 is often already something else, and a dev server that exits with
 * EADDRINUSE is a dead end. Walk up until one is free and print what we got.
 */
function listenOnFreePort(
  server: ReturnType<typeof createServer>,
  preferred: number,
): Promise<number> {
  return new Promise((resolve, reject) => {
    let candidate = preferred;

    const attempt = (): void => {
      server.once("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "EADDRINUSE" && candidate < preferred + 20) {
          console.log(`port ${candidate} is busy, trying ${candidate + 1}`);
          candidate += 1;
          attempt();
          return;
        }
        reject(error);
      });
      server.listen(candidate, () => {
        resolve(candidate);
      });
    };

    attempt();
  });
}

async function ensureDevUser(pool: Pool): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO users (x_handle, x_user_id)
     VALUES ('dev', 'dev-user')
     ON CONFLICT (x_user_id) DO UPDATE SET x_handle = EXCLUDED.x_handle
     RETURNING id`,
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error("could not create the dev user");
  return row.id;
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close(() => {
      void pool.end().then(() => process.exit(0));
    });
  });
}
