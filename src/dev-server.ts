import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import type { Pool } from "pg";
import { claimBlocks } from "./board/claim.js";
import { runReservationSweep } from "./board/cleanup.js";
import {
  getCompositeBoard,
  invalidateCompositeBoard,
  localAvatarStore,
  renderPlanet,
} from "./board/composite.js";
import { clickSummary, recordClick } from "./board/clicks.js";
import {
  categoryCounts,
  isCategory,
  orbitAvailability,
  searchDirectory,
} from "./board/discovery.js";
import { ClaimError, TileConflictError } from "./board/errors.js";
import { deadLinks, runLinkCheckSweep } from "./board/links.js";
import { changeBlock, changeHistory, quoteChange } from "./board/resize.js";
import {
  BADGE_HEIGHT,
  BADGE_WIDTH,
  embedSnippet,
  listingPage,
  renderBadge,
  renderShareCard,
  shareSubject,
} from "./board/share.js";
import { isInUniverse, isValidSize } from "./board/geometry.js";
import type { Placement } from "./board/geometry.js";
import { createCheckout, readCheckout } from "./board/checkout.js";
import { lapseSubscription, releaseLapsedSubscriptions } from "./board/lifecycle.js";
import {
  ListingRejected,
  MAX_UPLOAD_BYTES,
  TrialRefused,
  UploadRejected,
  saveListing,
  startTrial,
  storeAvatar,
} from "./board/listing.js";
import { markEventProcessed, recordWebhookEvent } from "./payments/events.js";
import { fulfilPayment } from "./payments/fulfilment.js";
import { verifyWebhookSignature } from "./payments/signature.js";
import {
  PolarError,
  createCheckout as createPolarCheckout,
  interpretEvent,
  readPolarConfig,
} from "./payments/polar.js";
import {
  BlockNotLiveError,
  InvalidFeaturedDaysError,
  UnknownBlockError,
  activeFeatured,
  featureBlock,
} from "./board/featured.js";
import { availabilityBitmap, buildManifest, heldTileCount } from "./board/manifest.js";
import { currentlyWatching, startWatchingTicker } from "./board/watching.js";
import {
  AURAS,
  BILLING_INTERVAL,
  BOARD_CENTER,
  BOARD_SIZE,
  FEATURED_MAX_DAYS,
  FEATURED_MIN_DAYS,
  FEATURED_SLOTS,
  MAX_BLOCK_SIZE,
  ORBITS,
  TILE_COUNT,
  TILE_INSET,
  TILE_PIXELS,
  UNIVERSE_RADIUS,
  MONTHLY_FLOOR_CENTS,
  MONTHS_PER_TERM,
  TRIAL_DAYS,
  estimatedMonthlyClicks,
  featuredPriceCents,
  isValidFeaturedDays,
  monthlyPriceCents,
  orbitAt,
  orderTotals,
  sizeCapAt,
} from "./config.js";
import { createPool } from "./db/client.js";
import { migrate } from "./db/migrate.js";
import sharp from "sharp";
import { seedBoard } from "./seed.js";

/**
 * Development harness. It serves the board so the rendering work can be looked
 * at before a frontend framework is chosen; the routing here is throwaway, but
 * everything it calls into (manifest, composite, claim) is not.
 */

const PUBLIC_DIR = new URL("../public/", import.meta.url);
const AVATAR_DIR = new URL("../var/avatars/", import.meta.url);

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

const migrations = await migrate(pool, true);
if (migrations.applied.length > 0) console.log(`migrated: ${migrations.applied.join(", ")}`);
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

/**
 * Both sweeps, on a timer.
 *
 * Reservations lapse in minutes so that one runs often; subscriptions lapse in
 * days so that one does not need to. Each is idempotent and each is also
 * reachable over HTTP, so neither depends on this timer being alive.
 */
const reservationSweep = setInterval(() => {
  void runReservationSweep(pool).catch((error: unknown) => {
    console.error("reservation sweep failed:", error);
  });
}, 60_000);
reservationSweep.unref();

const subscriptionSweep = setInterval(() => {
  void releaseLapsedSubscriptions(pool).catch((error: unknown) => {
    console.error("subscription sweep failed:", error);
  });
}, 10 * 60_000);
subscriptionSweep.unref();

/**
 * Link health, on a slow rotation.
 *
 * Hourly rather than daily: each pass takes a small batch of the planets that
 * are actually due, so the work spreads out instead of arriving all at once,
 * and a board that has just been seeded works through itself over a day.
 */
const linkSweep = setInterval(() => {
  void runLinkCheckSweep(pool).catch((error: unknown) => {
    console.error("link sweep failed:", error);
  });
}, 60 * 60_000);
linkSweep.unref();

/**
 * Distinguishes "this request failed" from "the database is gone".
 *
 * The second one used to leave a process holding the port and answering every
 * request with a 500, which is worse than not being there: the pool-level
 * handler only fires for idle clients, never for a failure hit mid-request.
 */
function isConnectionFailure(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { code?: unknown }).code;
  const message = (error as { message?: unknown }).message;
  return (
    code === "ECONNREFUSED" ||
    code === "ECONNRESET" ||
    code === "ENOTFOUND" ||
    code === "57P01" || // admin shutdown
    code === "57P02" || // crash shutdown
    code === "57P03" || // cannot connect now
    (typeof message === "string" && /Connection terminated|server closed the connection/i.test(message))
  );
}

const server = createServer((req, res) => {
  void handle(req, res).catch((error: unknown) => {
    console.error(error);
    if (!res.headersSent) sendJson(res, 500, { error: "internal_error" });
    if (isConnectionFailure(error)) {
      console.error("lost the database mid-request, shutting down.");
      process.exit(1);
    }
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

    // The share surface: one page per planet, the card its meta tags point at,
    // and the badge an owner puts on their own site.
    const listing = /^\/b\/([\w.-]{1,40})$/.exec(path);
    if (listing?.[1] !== undefined) return sendListingPage(req, res, listing[1]);

    const card = /^\/card\/([0-9a-f-]{36})\.png$/.exec(path);
    if (card?.[1] !== undefined) return sendShareCard(res, card[1]);

    const badge = /^\/badge\/([0-9a-f-]{36})\.svg$/.exec(path);
    if (badge?.[1] !== undefined) return sendBadge(res, badge[1]);

    const embed = /^\/api\/block\/([0-9a-f-]{36})\/embed$/.exec(path);
    if (embed?.[1] !== undefined) return sendEmbed(req, res, embed[1]);
    if (path === "/api/manifest") return sendManifest(req, res);
    if (path === "/api/availability") return sendAvailability(res);
    if (path === "/api/featured") return sendJson(res, 200, await featured(pool));
    if (path === "/api/links/dead") return sendJson(res, 200, { blocks: await deadLinks(pool) });
    if (path === "/api/stats") return sendJson(res, 200, await stats(pool));
    if (path === "/api/board") return sendJson(res, 200, await boardState(pool));
    if (path === "/api/orbits") return sendJson(res, 200, { orbits: await orbitAvailability(pool) });
    if (path === "/api/categories") {
      return sendJson(res, 200, { categories: await categoryCounts(pool) });
    }

    if (path === "/api/directory") {
      const category = requestUrl.searchParams.get("category");
      if (category !== null && !isCategory(category)) {
        return sendJson(res, 400, { error: "unknown_category", category });
      }
      return sendJson(
        res,
        200,
        await searchDirectory(pool, {
          text: requestUrl.searchParams.get("q") ?? "",
          ...(category !== null ? { category } : {}),
          limit: Number(requestUrl.searchParams.get("limit") ?? "40"),
          offset: Number(requestUrl.searchParams.get("offset") ?? "0"),
        }),
      );
    }

    const avatar = /^\/avatars\/([\w.-]+)$/.exec(path);
    if (avatar?.[1] !== undefined) {
      return sendFile(res, new URL(basename(avatar[1]), AVATAR_DIR));
    }

    const planet = /^\/api\/planet\/([0-9a-f-]{36})$/.exec(path);
    if (planet?.[1] !== undefined) {
      return sendPlanet(req, res, planet[1], Number(requestUrl.searchParams.get("px") ?? "128"));
    }

    const block = /^\/api\/block\/([0-9a-f-]{36})$/.exec(path);
    if (block?.[1] !== undefined) return sendBlockDetail(res, block[1]);

    // The outbound link. Every click on a planet goes through here so it can be
    // counted, which is the only reason an owner can see what they are paying
    // for.
    const outbound = /^\/go\/([0-9a-f-]{36})$/.exec(path);
    if (outbound?.[1] !== undefined) return sendOutbound(req, res, outbound[1]);

    const history = /^\/api\/block\/([0-9a-f-]{36})\/changes$/.exec(path);
    if (history?.[1] !== undefined) {
      return sendJson(res, 200, { changes: await changeHistory(pool, history[1]) });
    }

    const clicks = /^\/api\/block\/([0-9a-f-]{36})\/clicks$/.exec(path);
    if (clicks?.[1] !== undefined) {
      const days = Number(requestUrl.searchParams.get("days") ?? "30");
      return sendJson(res, 200, await clickSummary(pool, clicks[1], days));
    }

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
      const x = Number(requestUrl.searchParams.get("x") ?? "0");
      const y = Number(requestUrl.searchParams.get("y") ?? "0");
      // Refuse to price something nobody can buy: a quote for a 26x26, or for
      // a spot out in the void, is a number checkout could never honour.
      if (!isValidSize(size)) {
        return sendJson(res, 400, {
          error: "invalid_size",
          message: `Planets run from 1x1 to ${MAX_BLOCK_SIZE}x${MAX_BLOCK_SIZE}.`,
          maxBlockSize: MAX_BLOCK_SIZE,
        });
      }
      if (!isInUniverse({ x, y, size })) {
        return sendJson(res, 400, {
          error: "outside_universe",
          message: "Nothing out there is for sale.",
        });
      }
      const cap = sizeCapAt(x, y, size);
      if (size > cap) {
        return sendJson(res, 400, {
          error: "size_not_allowed_here",
          message: `That orbit takes planets up to ${cap}x${cap}.`,
          cap,
        });
      }
      return sendJson(res, 200, quote(x, y, size));
    }
  }

  if (method === "POST") {
    if (path === "/api/claim") return claim(req, res);
    if (path === "/api/checkout") return checkout(req, res);
    if (path === "/api/featured") return buyFeatured(req, res);
    if (path === "/api/webhooks/polar") return polarWebhook(req, res);

    const upload = /^\/api\/upload\/(chk_[0-9a-f-]{36})$/.exec(path);
    if (upload?.[1] !== undefined) return uploadAvatar(req, res, upload[1]);

    const listing = /^\/api\/listing\/(chk_[0-9a-f-]{36})$/.exec(path);
    if (listing?.[1] !== undefined) return putListing(req, res, listing[1]);

    const change = /^\/api\/block\/([0-9a-f-]{36})\/change$/.exec(path);
    if (change?.[1] !== undefined) return applyChange(req, res, change[1]);

    const changeQuote = /^\/api\/block\/([0-9a-f-]{36})\/change\/quote$/.exec(path);
    if (changeQuote?.[1] !== undefined) return quoteBlockChange(req, res, changeQuote[1]);

    const trial = /^\/api\/checkout\/(chk_[0-9a-f-]{36})\/trial$/.exec(path);
    if (trial?.[1] !== undefined) return beginTrial(res, trial[1]);
    if (path === "/api/sweep/subscriptions") {
      return sendJson(res, 200, await releaseLapsedSubscriptions(pool));
    }

    const pay = /^\/api\/checkout\/(chk_[0-9a-f-]{36})\/pay$/.exec(path);
    if (pay?.[1] !== undefined) return payCheckout(req, res, pay[1]);
    if (path === "/api/sweep") return sendJson(res, 200, await runReservationSweep(pool));
    if (path === "/api/sweep/links") return sendJson(res, 200, await runLinkCheckSweep(pool));
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

/**
 * One planet, rendered on its own at a requested size.
 *
 * The board sheet is drawn at twelve pixels per tile, which is right for
 * looking at the whole universe and far too coarse once someone zooms into a
 * single world: a 1x1 planet is ten pixels there. Rather than ship a sharper
 * sheet, which would be enormous and mostly wasted, the client asks for detail
 * only for the planets it is actually showing large.
 *
 * Sizes are restricted to a few tiers so the cache is small and shared: a
 * hundred people zooming into the same planet render it once.
 */
const PLANET_TIERS = [64, 128, 256, 512];
const planetCache = new Map<string, Buffer>();
const PLANET_CACHE_LIMIT = 400;

async function sendPlanet(
  req: IncomingMessage,
  res: ServerResponse,
  blockId: string,
  requestedPx: number,
): Promise<void> {
  const px = PLANET_TIERS.find((tier) => tier >= requestedPx) ?? PLANET_TIERS[PLANET_TIERS.length - 1];
  if (px === undefined) return sendJson(res, 400, { error: "bad_size" });

  const key = `${blockId}:${px}`;
  const etag = `"planet-${key}"`;
  if (req.headers["if-none-match"] === etag) {
    res.writeHead(304, { etag }).end();
    return;
  }

  let image = planetCache.get(key);
  if (image === undefined) {
    const found = await pool.query<{ image_url: string | null }>(
      `SELECT image_url FROM blocks WHERE id = $1 AND status = 'live'`,
      [blockId],
    );
    const imageUrl = found.rows[0]?.image_url;
    if (imageUrl === undefined || imageUrl === null) {
      return sendJson(res, 404, { error: "not_found" });
    }

    try {
      // WebP, not the PNG the sheet compositor wants: a 512px sprite is 283KB
      // as PNG and a fraction of that as WebP, and these are fetched per planet
      // per zoom level.
      image = await sharp(await renderPlanet(await avatars.read(imageUrl), px))
        .webp({ quality: 90, alphaQuality: 90 })
        .toBuffer();
    } catch {
      return sendJson(res, 404, { error: "avatar_unavailable" });
    }

    // Oldest out first: whoever is zoomed in now is who matters.
    if (planetCache.size >= PLANET_CACHE_LIMIT) {
      const oldest = planetCache.keys().next().value;
      if (oldest !== undefined) planetCache.delete(oldest);
    }
    planetCache.set(key, image);
  }

  res.writeHead(200, {
    "content-type": "image/webp",
    "content-length": image.length,
    "cache-control": "public, max-age=600",
    "x-content-type-options": "nosniff",
    etag,
  });
  res.end(image);
}

/**
 * Where a shared link lands.
 *
 * By handle rather than by id, because this is the address a person puts in
 * their bio and ids are not for reading.
 */
async function sendListingPage(
  req: IncomingMessage,
  res: ServerResponse,
  handle: string,
): Promise<void> {
  const subject = await shareSubject(pool, { handle });
  if (subject === null) {
    res.writeHead(404, { "content-type": "text/html; charset=utf-8" });
    res.end("<!doctype html><meta charset=utf-8><title>Not here</title>" +
      "<body style=\"background:#05070f;color:#e6edf9;font-family:sans-serif\">" +
      "<p>No planet by that name. <a style=color:#7aa2ff href=\"/\">Back to the universe</a>.</p>");
    return;
  }

  const html = listingPage(originOf(req), subject);
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "public, max-age=300",
  });
  res.end(html);
}

/**
 * The card a scraper fetches.
 *
 * Cached for an hour and marked immutable for that hour: scrapers refetch
 * eagerly and the card only changes when the owner edits their listing.
 */
async function sendShareCard(res: ServerResponse, id: string): Promise<void> {
  const subject = await shareSubject(pool, { id });
  if (subject === null) return sendJson(res, 404, { error: "not_found" });

  const png = await renderShareCard(subject, avatars);
  res.writeHead(200, {
    "content-type": "image/png",
    "content-length": png.length,
    "cache-control": "public, max-age=3600",
  });
  res.end(png);
}

async function sendBadge(res: ServerResponse, id: string): Promise<void> {
  const subject = await shareSubject(pool, { id });
  if (subject === null) return sendJson(res, 404, { error: "not_found" });

  const svg = renderBadge(subject);
  res.writeHead(200, {
    "content-type": "image/svg+xml; charset=utf-8",
    "cache-control": "public, max-age=3600",
    // It is meant to be hotlinked from the owner's own site. That is the point.
    "access-control-allow-origin": "*",
  });
  res.end(svg);
}

/** The snippet to copy, and the pieces to build a different one from. */
async function sendEmbed(
  req: IncomingMessage,
  res: ServerResponse,
  id: string,
): Promise<void> {
  const subject = await shareSubject(pool, { id });
  if (subject === null) return sendJson(res, 404, { error: "not_found" });

  const origin = originOf(req);
  sendJson(res, 200, {
    snippet: embedSnippet(origin, subject),
    badgeUrl: `${origin}/badge/${subject.id}.svg`,
    cardUrl: `${origin}/card/${subject.id}.png`,
    pageUrl: `${origin}/b/${subject.handle}`,
    width: BADGE_WIDTH,
    height: BADGE_HEIGHT,
  });
}

/**
 * The address this request arrived on.
 *
 * It has to be absolute: a card URL is read by someone else's server, and a
 * relative one means nothing to them. The Host header is trusted here because
 * this is the development harness; behind a real proxy this comes from
 * configuration, not from the request.
 */
function originOf(req: IncomingMessage): string {
  const host = req.headers.host ?? `localhost:${port}`;
  const proto = req.headers["x-forwarded-proto"] === "https" ? "https" : "http";
  return `${proto}://${host}`;
}

async function sendBlockDetail(res: ServerResponse, id: string): Promise<void> {
  const result = await pool.query(
    `SELECT id, x, y, size, display_name AS name, handle, primary_url AS url,
            image_url, category, description, links, click_count, published_at,
            link_ok, link_checked_at
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
    boardCenter: BOARD_CENTER,
    universeRadius: UNIVERSE_RADIUS,
    maxBlockSize: MAX_BLOCK_SIZE,
    // The orbits, so the client can draw them and price a drag as it happens.
    // What is actually charged is still computed server side at checkout.
    orbits: ORBITS,
    auras: AURAS,
    trialDays: TRIAL_DAYS,
    interval: BILLING_INTERVAL,
    monthsPerTerm: MONTHS_PER_TERM,
    monthlyFloorCents: MONTHLY_FLOOR_CENTS,
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
 * What a planet at a given place would cost. Position matters as much as size
 * now: the same square is five times the price in the core as in the outer
 * reach, so a quote without coordinates would be meaningless.
 */
function quote(x: number, y: number, size: number): unknown {
  const middle = Math.floor(size / 2);
  const monthlyCents = monthlyPriceCents(x, y, size);
  return {
    x,
    y,
    size,
    tiles: size * size,
    monthlyCents,
    ...orderTotals([monthlyCents]),
    orbit: orbitAt(x + middle, y + middle)?.label ?? "Void",
  };
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
    return badRequest(res, error);
  }

  try {
    const session = await createCheckout(pool, devUserId, placements);
    // What the order might actually be worth, alongside what it costs. Clearly
    // a projection: nothing has measured a click yet.
    const reach = session.lines.map((line) =>
      estimatedMonthlyClicks(line.x, line.y, line.size, currentlyWatching()),
    );
    return sendJson(res, 201, {
      ...session,
      trialDays: TRIAL_DAYS,
      reach: {
        low: reach.reduce((sum, r) => sum + r.low, 0),
        high: reach.reduce((sum, r) => sum + r.high, 0),
        basis: reach[0]?.basis ?? "",
      },
    });
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
 * The cover photo for an order's planets.
 *
 * Takes the raw bytes rather than a form encoding, so there is no filename and
 * no declared type to be wrong about. Whatever arrives is decoded, measured,
 * and re-encoded into one known-good square WebP before it is stored; see
 * normaliseAvatar for why that matters more than any of the checks around it.
 */
async function uploadAvatar(
  req: IncomingMessage,
  res: ServerResponse,
  checkoutId: string,
): Promise<void> {
  const blocks = await readCheckout(pool, checkoutId);
  if (blocks.length === 0) return sendJson(res, 404, { error: "unknown_checkout" });

  let bytes: Buffer;
  try {
    bytes = await readRawBinary(req, MAX_UPLOAD_BYTES);
  } catch (error) {
    return badRequest(res, error);
  }

  try {
    // Every planet in the order wears the same face, stored once per planet
    // because the compositor looks images up by block.
    let stored = { imageUrl: "", storedBytes: 0 };
    for (const block of blocks) {
      stored = await storeAvatar(AVATAR_DIR, block.id, bytes);
      // Writing the file is not the same as having a listing with a photo.
      // Without this the planet has an image on disk that nothing points at.
      await pool.query(`UPDATE blocks SET image_url = $2 WHERE id = $1`, [
        block.id,
        stored.imageUrl,
      ]);
    }
    invalidateCompositeBoard();
    return sendJson(res, 201, { ...stored, planets: blocks.length });
  } catch (error) {
    if (error instanceof UploadRejected) {
      return sendJson(res, error.status, { error: error.code, message: error.message });
    }
    throw error;
  }
}

/** Name, link, description and aura, applied to every planet in the order. */
async function putListing(
  req: IncomingMessage,
  res: ServerResponse,
  checkoutId: string,
): Promise<void> {
  let body: Record<string, unknown>;
  try {
    body = await readJson(req);
  } catch (error) {
    return badRequest(res, error);
  }

  try {
    const result = await saveListing(pool, checkoutId, {
      displayName: String(body["displayName"] ?? ""),
      primaryUrl: String(body["primaryUrl"] ?? ""),
      description: String(body["description"] ?? ""),
      aura: String(body["aura"] ?? ""),
      ...(typeof body["handle"] === "string" ? { handle: body["handle"] } : {}),
    });
    invalidateCompositeBoard();
    return sendJson(res, 200, result);
  } catch (error) {
    if (error instanceof ListingRejected) {
      return sendJson(res, error.status, { error: error.code, message: error.message });
    }
    throw error;
  }
}

/** Three days on the board without paying, once per account. */
async function beginTrial(res: ServerResponse, checkoutId: string): Promise<void> {
  try {
    const result = await startTrial(pool, devUserId, checkoutId);
    invalidateCompositeBoard();
    return sendJson(res, 201, { ...result, trialDays: TRIAL_DAYS });
  } catch (error) {
    if (error instanceof TrialRefused) {
      return sendJson(res, error.status, { error: error.code, message: error.message });
    }
    throw error;
  }
}

/** Raw bytes, bounded. Used by uploads, where there is nothing to parse. */
async function readRawBinary(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > maxBytes) {
      throw new BadRequestError(`Images must be ${maxBytes / 1024 / 1024}MB or smaller.`, 413);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

/**
 * The provider's webhook, and the only thing allowed to move a block out of
 * 'reserved'.
 *
 * Order matters and it is the same order for every provider:
 *
 *   1. read the raw bytes, because the signature covers those exact bytes and
 *      a body that has been parsed and re-serialised will not verify
 *   2. verify the signature, before parsing anything or trusting any field
 *   3. record the delivery, so a retry of the same event cannot act twice
 *   4. only then act
 *
 * Steps two and three are what make this safe to expose. Without the first, the
 * second silently never works.
 */
async function polarWebhook(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let rawBody: string;
  try {
    rawBody = await readRawBody(req);
  } catch (error) {
    return badRequest(res, error);
  }

  const secret = process.env["POLAR_WEBHOOK_SECRET"];
  if (secret === undefined || secret === "") {
    // Refusing beats accepting unsigned deliveries. Polar is not wired yet, so
    // this is the expected answer until a secret exists.
    return sendJson(res, 503, {
      error: "webhook_secret_not_configured",
      message:
        "POLAR_WEBHOOK_SECRET is not set, so signatures cannot be checked and no delivery " +
        "will be accepted. Refusing beats trusting an unsigned body.",
    });
  }

  const signature = verifyWebhookSignature({
    rawBody,
    id: header(req, "webhook-id"),
    timestamp: header(req, "webhook-timestamp"),
    signature: header(req, "webhook-signature"),
    secret,
  });
  if (!signature.valid) {
    // The reason goes to the log, never to the caller: it would tell whoever is
    // probing exactly which check to defeat next.
    console.warn(`rejected webhook: ${signature.reason ?? "invalid signature"}`);
    return sendJson(res, 401, { error: "invalid_signature" });
  }

  let event: { type?: unknown; data?: unknown };
  try {
    event = JSON.parse(rawBody) as typeof event;
  } catch {
    return sendJson(res, 400, { error: "bad_request", message: "body is not valid JSON" });
  }

  const eventType = typeof event.type === "string" ? event.type : null;
  // The delivery id from the signed headers is the idempotency key: it is the
  // thing the provider repeats when it retries, and it is covered by the
  // signature, so it cannot be forged into a fresh delivery.
  const eventId = header(req, "webhook-id") ?? null;
  if (eventId === null || eventType === null) {
    return sendJson(res, 400, { error: "bad_request", message: "missing delivery id or type" });
  }

  const recorded = await recordWebhookEvent(pool, {
    provider: "polar",
    eventId,
    eventType,
    payload: event,
  });

  // A retry. Acknowledge it so the provider stops resending, and change nothing.
  if (recorded.duplicate) {
    return sendJson(res, 200, { received: true, duplicate: true, eventId });
  }

  const outcome = await applyEvent(eventType, event.data);
  await markEventProcessed(pool, recorded.id, outcome.summary);
  return sendJson(res, 200, { received: true, duplicate: false, ...outcome.body });
}

/**
 * What each event means for the board.
 *
 * Amounts are never read from the payload. The payload says which order and
 * which subscription; what that costs, and what any refund is worth, is derived
 * from the blocks themselves.
 */
/**
 * One delivery, one decision, carried out.
 *
 * What an event means lives in payments/polar.ts, where it can be tested
 * without a socket. This is only the part that touches the database, and every
 * branch returns a summary, because the summary is what someone reads when a
 * customer asks what happened to their order.
 */
async function applyEvent(
  eventType: string,
  data: unknown,
): Promise<{ summary: string; body: Record<string, unknown> }> {
  const action = interpretEvent(eventType, data);

  switch (action.kind) {
    case "fulfil": {
      const result = await fulfilPayment(pool, {
        checkoutId: action.checkoutId,
        subscriptionId: action.subscriptionId,
        currentPeriodEnd: action.currentPeriodEnd,
      });
      invalidateCompositeBoard();

      return {
        summary:
          `${result.status}: delivered ${result.delivered.length}, ` +
          `lost ${result.lost.length}, refund ${result.refundCents}`,
        body: { fulfilment: result },
      };
    }

    case "feature": {
      try {
        const slot = await featureBlock(pool, action.blockId, action.days);
        return {
          summary: `featured ${action.blockId} for ${action.days} day(s)`,
          body: { featured: slot },
        };
      } catch (error) {
        // The money has already been taken, so this cannot throw its way out of
        // the handler: that would make Polar retry forever against a block that
        // is never going to be featurable.
        const message = error instanceof Error ? error.message : String(error);
        console.error(`could not feature ${action.blockId}: ${message}`);
        return { summary: `could not feature: ${message}`, body: { failed: true } };
      }
    }

    case "renew": {
      const renewed = await pool.query(
        `UPDATE blocks
            SET current_period_end = coalesce($2::timestamptz, current_period_end)
          WHERE subscription_id = $1`,
        [action.subscriptionId, action.currentPeriodEnd],
      );
      return {
        summary: `renewed ${renewed.rowCount ?? 0} block(s) to ${action.currentPeriodEnd?.toISOString() ?? "no new date"}`,
        body: { renewed: renewed.rowCount ?? 0 },
      };
    }

    case "lapse": {
      const lapsed = await lapseSubscription(pool, action.subscriptionId);
      invalidateCompositeBoard();
      return {
        summary: `lapsed ${lapsed.blocks.length} block(s), freed ${lapsed.tilesReleased} tile(s)`,
        body: { lapsed },
      };
    }

    default:
      // Recorded, acknowledged, and deliberately not acted on. Everything a
      // provider sends is stored either way, so an unhandled type is visible.
      return { summary: action.reason, body: { ignored: true } };
  }
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/**
 * The exact bytes, unparsed.
 *
 * readJson cannot be reused here: it returns an object, and re-serialising that
 * object produces different bytes to the ones that were signed. Key order and
 * whitespace both matter to an HMAC.
 */
async function readRawBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      throw new BadRequestError(`request body exceeds ${MAX_BODY_BYTES} bytes`, 413);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * The buy button's endpoint.
 *
 * Everything a real payment needs is in place: the order exists, the tiles are
 * held, and the amount is known. The only missing piece is the provider, so
 * this answers 503 rather than pretending. When Polar is wired up, this is
 * where the checkout is created and a redirect URL comes back.
 */
async function payCheckout(
  req: IncomingMessage,
  res: ServerResponse,
  checkoutId: string,
): Promise<void> {
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

  const polar = readPolarConfig();
  if (!polar.ok) {
    return sendJson(res, 503, {
      error: "payment_provider_not_configured",
      provider: "polar",
      message:
        `Polar is not connected: ${polar.missing.join(", ")} ${polar.missing.length === 1 ? "is" : "are"} not set. ` +
        "No charge was attempted, and the tiles stay held until the reservation lapses.",
      missing: polar.missing,
      checkoutId,
      blocks: blocks.length,
    });
  }

  // Priced here, from the squares the database says are in this order. The
  // browser sent an id and nothing else, which is the point: a price that
  // arrives in a request body is a price the buyer chose.
  const totals = orderTotals(blocks.map((block) => monthlyPriceCents(block.x, block.y, block.size)));

  try {
    const session = await createPolarCheckout(polar.config, {
      productId: polar.config.subscriptionProductId,
      amountCents: totals.termTotalCents,
      successUrl: `${originOf(req)}/?paid=${encodeURIComponent(checkoutId)}`,
      metadata: { kind: "subscription", checkout_id: checkoutId, blocks: blocks.length },
    });

    return sendJson(res, 200, {
      checkoutId,
      provider: "polar",
      redirectUrl: session.url,
      sessionId: session.id,
      amountCents: totals.termTotalCents,
      months: totals.months,
    });
  } catch (error) {
    if (error instanceof PolarError) {
      // Polar refusing an order is not this server failing, and the buyer needs
      // to know their tiles are still held while they work out what happened.
      console.error(`polar checkout failed for ${checkoutId}: ${error.message}`);
      return sendJson(res, 502, {
        error: "payment_provider_error",
        message: "The payment provider would not open a checkout. Your tiles are still held.",
        checkoutId,
      });
    }
    throw error;
  }
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
    return badRequest(res, error);
  }

  try {
    if (!isValidFeaturedDays(days)) throw new InvalidFeaturedDaysError(days);

    const polar = readPolarConfig();
    if (!polar.ok) {
      // Without a provider the slot is granted outright, because the whole
      // point of the dev harness is to see the column fill up. A configured
      // deployment never reaches this branch.
      const slot = await featureBlock(pool, blockId, days);
      return sendJson(res, 201, { ...slot, days, charged: false, provider: null });
    }

    // Checked before taking money, so nobody pays for a slot that could never
    // be shown. featureBlock checks it again when the webhook lands, because by
    // then the block may have gone.
    const target = await pool.query<{ status: string }>(
      `SELECT status FROM blocks WHERE id = $1`,
      [blockId],
    );
    const status = target.rows[0]?.status;
    if (status === undefined) throw new UnknownBlockError(blockId);
    if (status !== "live") throw new BlockNotLiveError(status);

    const session = await createPolarCheckout(polar.config, {
      productId: polar.config.featuredProductId,
      amountCents: featuredPriceCents(days),
      successUrl: `${originOf(req)}/?featured=${encodeURIComponent(blockId)}`,
      metadata: { kind: "featured", block_id: blockId, days },
    });

    return sendJson(res, 200, {
      provider: "polar",
      redirectUrl: session.url,
      sessionId: session.id,
      days,
      amountCents: featuredPriceCents(days),
      charged: false,
    });
  } catch (error) {
    if (error instanceof PolarError) {
      console.error(`polar featured checkout failed for ${blockId}: ${error.message}`);
      return sendJson(res, 502, {
        error: "payment_provider_error",
        message: "The payment provider would not open a checkout. Nothing was charged.",
      });
    }
    if (
      error instanceof InvalidFeaturedDaysError ||
      error instanceof UnknownBlockError ||
      error instanceof BlockNotLiveError
    ) {
      return sendJson(res, error.status, { error: error.code, message: error.message });
    }
    throw error;
  }
}

/**
 * What growing or moving this planet to a given square would do, without doing
 * it. The board needs this to show a price before anyone commits to anything.
 */
async function quoteBlockChange(
  req: IncomingMessage,
  res: ServerResponse,
  blockId: string,
): Promise<void> {
  let to: Placement;
  try {
    to = parsePlacement((await readJson(req)) as Record<string, unknown>);
  } catch (error) {
    return badRequest(res, error);
  }

  const current = await pool.query<{ x: number; y: number; size: number }>(
    `SELECT x, y, size FROM blocks WHERE id = $1 AND status = 'live'`,
    [blockId],
  );
  const from = current.rows[0];
  if (from === undefined) return sendJson(res, 404, { error: "unknown_block" });

  try {
    return sendJson(res, 200, quoteChange(from, to));
  } catch (error) {
    if (error instanceof ClaimError) {
      return sendJson(res, error.status, { error: error.code, message: error.message });
    }
    throw error;
  }
}

/**
 * Performs the change.
 *
 * The 409 body carries the same conflict list a failed first claim does,
 * because the board draws it the same way: the squares that are gone, flashing
 * red, with the planet exactly where it was.
 */
async function applyChange(
  req: IncomingMessage,
  res: ServerResponse,
  blockId: string,
): Promise<void> {
  let to: Placement;
  try {
    to = parsePlacement((await readJson(req)) as Record<string, unknown>);
  } catch (error) {
    return badRequest(res, error);
  }

  try {
    const applied = await changeBlock(pool, devUserId, blockId, to);
    invalidateCompositeBoard();
    return sendJson(res, 200, applied);
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

async function claim(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let placements: Placement[];
  try {
    const body = (await readJson(req)) as { placements?: unknown };
    placements = parsePlacements(body.placements);
  } catch (error) {
    return badRequest(res, error);
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

/** A cart bigger than this is not a cart. Bounds the work one request can ask for. */
const MAX_PLACEMENTS = 64;

/** One square, from a body that is only ever {x, y, size}. */
function parsePlacement(input: Record<string, unknown>): Placement {
  const [placement] = parsePlacements([input]);
  if (placement === undefined) throw new Error("expected x, y and size");
  return placement;
}

function parsePlacements(input: unknown): Placement[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw new Error("expected a non-empty placements array");
  }
  if (input.length > MAX_PLACEMENTS) {
    throw new Error(`a single order may contain at most ${MAX_PLACEMENTS} blocks`);
  }

  const placements = input.map((raw) => {
    const { x, y, size } = raw as Record<string, unknown>;
    // Integers only: a fractional or infinite coordinate has no meaning on a
    // tile grid and would reach the query as something SQL has to reject.
    if (!Number.isInteger(x) || !Number.isInteger(y) || !Number.isInteger(size)) {
      throw new Error("each placement needs whole-number x, y and size");
    }
    return { x: x as number, y: y as number, size: size as number };
  });

  const tiles = placements.reduce((sum, p) => sum + p.size * p.size, 0);
  if (tiles > TILE_COUNT) {
    throw new Error("that order covers more tiles than the board has");
  }
  return placements;
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
      "x-content-type-options": "nosniff",
    });
    res.end(body);
  } catch {
    sendJson(res, 404, { error: "not_found", file: basename(file.pathname) });
  }
}

/**
 * Follows a planet's link, counting the visit on the way.
 *
 * A dead or unpaid planet gets the board rather than an error page: these links
 * are public, they end up in bios and posts, and they outlive the planet they
 * pointed at.
 *
 * 302 rather than 301 so that nothing caches a destination the owner can change
 * from their dashboard tomorrow, and noreferrer so the destination does not
 * receive the visitor's previous page.
 */
async function sendOutbound(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
  const { url: destination } = await recordClick(pool, id, clientIp(req));

  res.writeHead(302, {
    Location: destination ?? "/",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store",
  });
  res.end();
}

/**
 * Who to count as one visitor.
 *
 * Behind a proxy the socket address is the proxy, so the forwarded header is
 * read first and only its first entry is trusted: the rest is whatever the
 * client chose to send. It is never stored, only hashed.
 */
function clientIp(req: IncomingMessage): string {
  const forwarded = req.headers["x-forwarded-for"];
  const header = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  const first = header?.split(",")[0]?.trim();
  return first !== undefined && first !== "" ? first : (req.socket.remoteAddress ?? "unknown");
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
    // Never let a browser guess a type for something we said was JSON.
    "x-content-type-options": "nosniff",
    ...headers,
  });
  res.end(payload);
}

/** Nothing this API accepts is large; anything bigger is a mistake or an attack. */
const MAX_BODY_BYTES = 64 * 1024;

/** Carries the status a bad request should get, so callers do not guess. */
class BadRequestError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "BadRequestError";
  }
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      // Stop accumulating, but leave the socket alone so the caller still gets
      // an answer. Destroying it here would surface as a connection error and
      // tell them nothing about what went wrong.
      throw new BadRequestError(`request body exceeds ${MAX_BODY_BYTES} bytes`, 413);
    }
    chunks.push(buffer);
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  if (raw.trim() === "") return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new BadRequestError("body is not valid JSON");
  }
}

function badRequest(res: ServerResponse, error: unknown): void {
  const status = error instanceof BadRequestError ? error.status : 400;
  sendJson(res, status, {
    error: status === 413 ? "payload_too_large" : "bad_request",
    message: error instanceof Error ? error.message : String(error),
  });
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
