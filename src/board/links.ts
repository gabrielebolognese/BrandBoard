import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { Pool } from "pg";
import {
  LINK_CHECK_BATCH,
  LINK_CHECK_INTERVAL_HOURS,
  LINK_CHECK_TIMEOUT_MS,
  LINK_DEAD_AFTER_FAILURES,
} from "../config.js";
import { withTransaction } from "../db/client.js";
import type { Queryable } from "../db/client.js";

/**
 * Link health.
 *
 * This is what killed the Million Dollar Homepage. The pixels sold once, the
 * links died one by one, and there was no mechanism to notice and no reason for
 * anyone to care. Renting rather than selling fixes most of it, because a
 * planet that stops being paid for leaves. This catches the rest: the planet is
 * paid up and the destination is gone.
 *
 * Nothing here takes a planet down. A dead link is reported to its owner and
 * marked on the planet; what happens after that is a policy question, and a
 * policy question should not be answered by a background job.
 */

export interface LinkCheckResult {
  readonly ok: boolean;
  readonly statusCode: number | null;
  readonly error: string | null;
  /** Where it ended up, when redirects were followed. */
  readonly finalUrl: string | null;
}

export interface CheckOptions {
  readonly timeoutMs?: number;
  readonly maxRedirects?: number;
  /** Injected by tests. Production uses global fetch. */
  readonly fetchImpl?: typeof fetch;
  /** Injected by tests. Production resolves through DNS. */
  readonly resolve?: (hostname: string) => Promise<string[]>;
}

/**
 * Checks one link.
 *
 * HEAD first, because it is the polite way to ask whether something is there,
 * then GET when the server does not implement it: plenty answer HEAD with 405
 * while serving the page perfectly well.
 *
 * Redirects are followed by hand rather than by fetch, so every hop is checked
 * against the same rules as the first. A link that is fine right up until it
 * redirects somewhere it should not is not a fine link.
 */
export async function checkLink(url: string, options: CheckOptions = {}): Promise<LinkCheckResult> {
  const doFetch = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? LINK_CHECK_TIMEOUT_MS;
  const maxRedirects = options.maxRedirects ?? 5;

  let current = url;

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    let parsed: URL;
    try {
      parsed = new URL(current);
    } catch {
      return failure("That is not a URL.");
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return failure(`Refusing to follow a ${parsed.protocol} link.`);
    }

    if (!(await isPubliclyRoutable(parsed.hostname, options.resolve))) {
      return failure("That address is not on the public internet.");
    }

    let response: Response;
    try {
      response = await request(doFetch, parsed, timeoutMs);
    } catch (error) {
      return failure(describe(error));
    }

    if (isRedirect(response.status)) {
      const location = response.headers.get("location");
      if (location === null || location === "") {
        return {
          ok: false,
          statusCode: response.status,
          error: "Redirected to nowhere.",
          finalUrl: current,
        };
      }
      current = new URL(location, parsed).toString();
      continue;
    }

    return {
      ok: response.status < 400,
      statusCode: response.status,
      error: response.status < 400 ? null : `Answered ${response.status}.`,
      finalUrl: current,
    };
  }

  return failure(`More than ${maxRedirects} redirects.`);
}

async function request(doFetch: typeof fetch, url: URL, timeoutMs: number): Promise<Response> {
  const headers = {
    // Saying who is calling is the courteous thing to do, and it gives anyone
    // reading their own logs somewhere to complain.
    "user-agent": "BrandSpaceLinkCheck/1.0 (+https://brandspace.app/link-checks)",
    accept: "*/*",
  };

  const head = await doFetch(url, {
    method: "HEAD",
    redirect: "manual",
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  });

  // A server that will not answer HEAD has not told us anything about the page.
  if (head.status !== 403 && head.status !== 405 && head.status !== 501) return head;

  return doFetch(url, {
    method: "GET",
    redirect: "manual",
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  });
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function failure(message: string): LinkCheckResult {
  return { ok: false, statusCode: null, error: message, finalUrl: null };
}

/**
 * Whether a hostname resolves to somewhere on the public internet.
 *
 * This job fetches addresses typed in by strangers, from inside our own
 * network. A link pointing at 169.254.169.254 or 10.0.0.5 would turn the
 * checker into a way of reading things only the server can reach, so every
 * address a hostname resolves to has to be public, not merely the first one.
 */
export async function isPubliclyRoutable(
  hostname: string,
  resolve?: (hostname: string) => Promise<string[]>,
): Promise<boolean> {
  const host = hostname.replace(/^\[|\]$/g, "");

  if (isIP(host) !== 0) return isPublicAddress(host);

  let addresses: string[];
  try {
    addresses =
      resolve !== undefined
        ? await resolve(host)
        : (await lookup(host, { all: true })).map((entry) => entry.address);
  } catch {
    return false;
  }

  return addresses.length > 0 && addresses.every(isPublicAddress);
}

/** Loopback, private, link-local, carrier-grade NAT, and the IPv6 equivalents. */
export function isPublicAddress(address: string): boolean {
  const version = isIP(address);

  if (version === 4) {
    const parts = address.split(".").map(Number);
    if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
      return false;
    }
    const [a = 0, b = 0] = parts;
    if (a === 0 || a === 10 || a === 127) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 169 && b === 254) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a >= 224) return false;
    return true;
  }

  if (version === 6) {
    const lower = address.toLowerCase();
    if (lower === "::" || lower === "::1") return false;

    // An IPv4 address wearing an IPv6 hat is still that IPv4 address.
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped?.[1] !== undefined) return isPublicAddress(mapped[1]);

    // Unique local, link local, multicast.
    if (/^f[cd]/.test(lower)) return false;
    if (/^fe[89ab]/.test(lower)) return false;
    if (lower.startsWith("ff")) return false;
    return true;
  }

  return false;
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") return "Timed out.";
    return error.message.slice(0, 200);
  }
  return String(error).slice(0, 200);
}

export interface DueBlock {
  readonly id: string;
  readonly url: string;
}

/**
 * The planets whose links are next in line, least recently checked first.
 *
 * SKIP LOCKED so that two sweeps running at once take different planets rather
 * than queueing behind one another, and so a sweep that dies mid-batch leaves
 * nothing stuck: the rows it was holding are simply due again.
 */
export async function blocksDueForCheck(
  tx: Queryable,
  limit = LINK_CHECK_BATCH,
): Promise<DueBlock[]> {
  const result = await tx.query<{ id: string; primary_url: string }>(
    `SELECT id, primary_url
       FROM blocks
      WHERE status = 'live'
        AND primary_url IS NOT NULL
        AND (link_checked_at IS NULL
             OR link_checked_at < now() - make_interval(hours => $2::int))
      ORDER BY link_checked_at NULLS FIRST
      LIMIT $1
      FOR UPDATE SKIP LOCKED`,
    [Math.max(1, Math.trunc(limit)), LINK_CHECK_INTERVAL_HOURS],
  );
  return result.rows.map((row) => ({ id: row.id, url: row.primary_url }));
}

/**
 * Writes down what a check found.
 *
 * The run of consecutive failures is reset on success rather than decremented,
 * because what matters is whether the link is broken now, not how often it has
 * ever been.
 */
export async function recordLinkCheck(
  tx: Queryable,
  blockId: string,
  url: string,
  result: LinkCheckResult,
): Promise<void> {
  await tx.query(
    `INSERT INTO link_checks (block_id, url, ok, status_code, error)
     VALUES ($1, $2, $3, $4, $5)`,
    [blockId, url, result.ok, result.statusCode, result.error],
  );

  await tx.query(
    `UPDATE blocks
        SET link_ok = $2,
            link_checked_at = now(),
            link_failures = CASE WHEN $2 THEN 0 ELSE link_failures + 1 END
      WHERE id = $1`,
    [blockId, result.ok],
  );
}

export interface SweepResult {
  readonly checked: number;
  readonly failed: number;
  readonly dead: string[];
}

export interface SweepOptions extends CheckOptions {
  readonly limit?: number;
}

/**
 * One pass of the rotation.
 *
 * The checks happen outside the transaction that chose the rows. Holding a
 * database transaction open across a dozen requests to other people's servers
 * is how a connection pool dies, and none of this needs to be atomic: a result
 * written twice is a result written twice.
 */
export async function runLinkCheckSweep(
  pool: Pool,
  options: SweepOptions = {},
): Promise<SweepResult> {
  const due = await withTransaction(pool, (tx) => blocksDueForCheck(tx, options.limit));
  if (due.length === 0) return { checked: 0, failed: 0, dead: [] };

  let failed = 0;
  for (const block of due) {
    const result = await checkLink(block.url, options);
    if (!result.ok) failed += 1;
    await recordLinkCheck(pool, block.id, block.url, result);
  }

  const dead = await deadLinks(pool);
  return { checked: due.length, failed, dead: dead.map((row) => row.id) };
}

export interface DeadLink {
  readonly id: string;
  readonly handle: string | null;
  readonly url: string;
  readonly failures: number;
}

/** Live planets whose link has failed enough times in a row to call it. */
export async function deadLinks(pool: Pool): Promise<DeadLink[]> {
  const result = await pool.query<{
    id: string;
    handle: string | null;
    primary_url: string;
    link_failures: number;
  }>(
    `SELECT id, handle, primary_url, link_failures
       FROM blocks
      WHERE status = 'live' AND link_ok IS FALSE AND link_failures >= $1
      ORDER BY link_failures DESC, handle`,
    [LINK_DEAD_AFTER_FAILURES],
  );
  return result.rows.map((row) => ({
    id: row.id,
    handle: row.handle,
    url: row.primary_url,
    failures: row.link_failures,
  }));
}
