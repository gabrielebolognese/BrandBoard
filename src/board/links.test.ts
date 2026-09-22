import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  checkLink,
  deadLinks,
  isPubliclyRoutable,
  isPublicAddress,
  recordLinkCheck,
  runLinkCheckSweep,
} from "./links.js";
import { LINK_DEAD_AFTER_FAILURES } from "../config.js";
import { createTestUser, hasDatabase, resetBoard, setupTestDatabase } from "../test/db.js";

/** Answers every request with one canned response, and remembers the calls. */
function stubFetch(
  responses: Array<{ status: number; location?: string }>,
): { impl: typeof fetch; calls: Array<{ url: string; method: string }> } {
  const calls: Array<{ url: string; method: string }> = [];
  let index = 0;

  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof URL ? input.toString() : String(input);
    calls.push({ url, method: init?.method ?? "GET" });

    const next = responses[Math.min(index, responses.length - 1)];
    index += 1;
    const headers = new Headers();
    if (next?.location !== undefined) headers.set("location", next.location);
    return new Response(null, { status: next?.status ?? 200, headers });
  }) as typeof fetch;

  return { impl, calls };
}

/** Everything resolves somewhere public unless a test says otherwise. */
const publicDns = async (): Promise<string[]> => ["93.184.216.34"];

describe("address rules", () => {
  it("accepts an ordinary public address", () => {
    expect(isPublicAddress("93.184.216.34")).toBe(true);
    expect(isPublicAddress("2606:2800:220:1:248:1893:25c8:1946")).toBe(true);
  });

  // The checker fetches addresses typed in by strangers from inside our
  // network, so this is the rule that keeps it from being used to read things
  // only the server can reach.
  it.each([
    ["127.0.0.1", "loopback"],
    ["10.1.2.3", "private"],
    ["172.16.0.1", "private"],
    ["192.168.1.1", "private"],
    ["169.254.169.254", "the cloud metadata address"],
    ["100.64.0.1", "carrier grade NAT"],
    ["0.0.0.0", "unspecified"],
    ["224.0.0.1", "multicast"],
    ["::1", "IPv6 loopback"],
    ["fd00::1", "IPv6 unique local"],
    ["fe80::1", "IPv6 link local"],
    ["::ffff:127.0.0.1", "IPv4 loopback wearing an IPv6 hat"],
  ])("refuses %s (%s)", (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it("refuses a hostname when any of its addresses is private", async () => {
    const resolve = async (): Promise<string[]> => ["93.184.216.34", "10.0.0.1"];
    expect(await isPubliclyRoutable("sneaky.example", resolve)).toBe(false);
  });

  it("refuses a hostname that does not resolve at all", async () => {
    const resolve = (): Promise<string[]> => Promise.reject(new Error("ENOTFOUND"));
    expect(await isPubliclyRoutable("nothing.example", resolve)).toBe(false);
  });
});

describe("checking a link", () => {
  it("calls a 200 healthy", async () => {
    const { impl, calls } = stubFetch([{ status: 200 }]);

    const result = await checkLink("https://example.com", { fetchImpl: impl, resolve: publicDns });

    expect(result).toMatchObject({ ok: true, statusCode: 200, error: null });
    expect(calls[0]?.method).toBe("HEAD");
  });

  it("calls a 404 broken", async () => {
    const { impl } = stubFetch([{ status: 404 }]);

    const result = await checkLink("https://example.com", { fetchImpl: impl, resolve: publicDns });

    expect(result.ok).toBe(false);
    expect(result.statusCode).toBe(404);
  });

  // Plenty of servers refuse HEAD and serve the page perfectly well, so a 405
  // is a statement about the method, not about the link.
  it("falls back to GET when HEAD is refused", async () => {
    const { impl, calls } = stubFetch([{ status: 405 }, { status: 200 }]);

    const result = await checkLink("https://example.com", { fetchImpl: impl, resolve: publicDns });

    expect(result.ok).toBe(true);
    expect(calls.map((call) => call.method)).toEqual(["HEAD", "GET"]);
  });

  it("follows a redirect to where it actually goes", async () => {
    const { impl } = stubFetch([
      { status: 301, location: "https://example.com/moved" },
      { status: 200 },
    ]);

    const result = await checkLink("https://example.com", { fetchImpl: impl, resolve: publicDns });

    expect(result.ok).toBe(true);
    expect(result.finalUrl).toBe("https://example.com/moved");
  });

  it("gives up on a redirect loop instead of following it forever", async () => {
    const { impl } = stubFetch([{ status: 302, location: "https://example.com/round" }]);

    const result = await checkLink("https://example.com", {
      fetchImpl: impl,
      resolve: publicDns,
      maxRedirects: 3,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/redirects/);
  });

  // A link that is fine until it redirects somewhere it should not is not fine.
  it("checks every hop, not only the first", async () => {
    const { impl } = stubFetch([
      { status: 302, location: "http://169.254.169.254/latest/meta-data/" },
      { status: 200 },
    ]);

    const result = await checkLink("https://example.com", { fetchImpl: impl, resolve: publicDns });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/public internet/);
  });

  it("refuses a scheme that is not http", async () => {
    const result = await checkLink("file:///etc/passwd", { resolve: publicDns });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Refusing/);
  });

  it("reports a network failure rather than throwing", async () => {
    const impl = (() => Promise.reject(new Error("socket hang up"))) as unknown as typeof fetch;

    const result = await checkLink("https://example.com", { fetchImpl: impl, resolve: publicDns });

    expect(result).toMatchObject({ ok: false, statusCode: null, error: "socket hang up" });
  });
});

const suite = describe.skipIf(!hasDatabase);

suite("link health over time [requires DATABASE_URL]", () => {
  let pool: Pool;
  let alice: string;

  beforeAll(async () => {
    pool = await setupTestDatabase();
  }, 30_000);

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await resetBoard(pool);
    alice = await createTestUser(pool, "alice");
  });

  it("checks a live planet and records the result", async () => {
    const block = await live(pool, alice);
    const { impl } = stubFetch([{ status: 200 }]);

    const result = await runLinkCheckSweep(pool, { fetchImpl: impl, resolve: publicDns });

    expect(result).toMatchObject({ checked: 1, failed: 0, dead: [] });
    expect(await stateOf(pool, block)).toMatchObject({ link_ok: true, link_failures: 0 });
  });

  it("does not check a planet that is not on the board", async () => {
    await pool.query(
      `INSERT INTO blocks (user_id, x, y, size, status, reserved_until, primary_url)
       VALUES ($1, 150, 150, 1, 'reserved', now() + interval '15 min', 'https://example.com')`,
      [alice],
    );
    const { impl } = stubFetch([{ status: 200 }]);

    expect(await runLinkCheckSweep(pool, { fetchImpl: impl, resolve: publicDns })).toMatchObject({
      checked: 0,
    });
  });

  it("checks each planet once, then has nothing left to do", async () => {
    await live(pool, alice);
    const { impl } = stubFetch([{ status: 200 }]);

    await runLinkCheckSweep(pool, { fetchImpl: impl, resolve: publicDns });
    const second = await runLinkCheckSweep(pool, { fetchImpl: impl, resolve: publicDns });

    expect(second.checked).toBe(0);
  });

  // One timeout is not a dead link, and the whole point of counting in a row is
  // that a link is only called dead once it has stayed that way.
  it("only calls a link dead after enough failures in a row", async () => {
    const block = await live(pool, alice);

    for (let attempt = 1; attempt < LINK_DEAD_AFTER_FAILURES; attempt += 1) {
      await recordLinkCheck(pool, block, "https://example.com", {
        ok: false,
        statusCode: 500,
        error: "Answered 500.",
        finalUrl: null,
      });
      expect(await deadLinks(pool)).toEqual([]);
    }

    await recordLinkCheck(pool, block, "https://example.com", {
      ok: false,
      statusCode: 500,
      error: "Answered 500.",
      finalUrl: null,
    });

    const dead = await deadLinks(pool);
    expect(dead).toHaveLength(1);
    expect(dead[0]?.failures).toBe(LINK_DEAD_AFTER_FAILURES);
  });

  it("forgives a link that comes back", async () => {
    const block = await live(pool, alice);

    for (let attempt = 0; attempt < LINK_DEAD_AFTER_FAILURES; attempt += 1) {
      await recordLinkCheck(pool, block, "https://example.com", {
        ok: false,
        statusCode: 500,
        error: "Answered 500.",
        finalUrl: null,
      });
    }
    await recordLinkCheck(pool, block, "https://example.com", {
      ok: true,
      statusCode: 200,
      error: null,
      finalUrl: null,
    });

    expect(await deadLinks(pool)).toEqual([]);
    expect(await stateOf(pool, block)).toMatchObject({ link_ok: true, link_failures: 0 });
  });

  it("keeps the history, not just the latest answer", async () => {
    const block = await live(pool, alice);

    await recordLinkCheck(pool, block, "https://example.com", {
      ok: false,
      statusCode: 503,
      error: "Answered 503.",
      finalUrl: null,
    });
    await recordLinkCheck(pool, block, "https://example.com", {
      ok: true,
      statusCode: 200,
      error: null,
      finalUrl: null,
    });

    const history = await pool.query<{ ok: boolean }>(
      `SELECT ok FROM link_checks WHERE block_id = $1 ORDER BY checked_at`,
      [block],
    );
    expect(history.rows.map((row) => row.ok)).toEqual([false, true]);
  });
});

async function live(pool: Pool, userId: string): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO blocks
       (user_id, x, y, size, status, published_at, image_url, display_name, handle, primary_url)
     VALUES ($1, 150, 150, 1, 'live', now(), 'https://cdn.example/a.webp', 'Alice', 'alice',
             'https://example.com')
     RETURNING id`,
    [userId],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error("insert returned no row");
  return row.id;
}

async function stateOf(
  pool: Pool,
  blockId: string,
): Promise<{ link_ok: boolean | null; link_failures: number }> {
  const result = await pool.query<{ link_ok: boolean | null; link_failures: number }>(
    `SELECT link_ok, link_failures FROM blocks WHERE id = $1`,
    [blockId],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error("no such block");
  return row;
}
