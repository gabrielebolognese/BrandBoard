import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  LINK_TTL_MINUTES,
  MAX_LINKS_PER_HOUR,
  SignInRefused,
  consumeSignInLink,
  normaliseEmail,
  requestSignInLink,
  signInEmail,
  sweepSignInLinks,
} from "./magiclink.js";
import {
  SESSION_COOKIE,
  clearedCookie,
  endAllSessions,
  endSession,
  readCookie,
  sessionCookie,
  startSession,
  sweepSessions,
  userForToken,
} from "./sessions.js";
import { hasDatabase, resetBoard, setupTestDatabase } from "../test/db.js";

describe("email addresses", () => {
  it("lowercases and trims, because nobody thinks theirs is case sensitive", () => {
    expect(normaliseEmail("  Someone@Example.COM ")).toBe("someone@example.com");
  });

  it.each(["", "nope", "a@b", "@example.com", "a@@b.com", "two@parts.com extra"])(
    "refuses %p",
    (input) => {
      expect(() => normaliseEmail(input)).toThrow(SignInRefused);
    },
  );

  // Loose on purpose. The real test of an address is whether mail to it
  // arrives, and every clever pattern rejects somebody's valid address.
  it.each(["a+tag@example.co.uk", "first.last@sub.domain.org", "x@y.io"])(
    "accepts %p",
    (input) => {
      expect(normaliseEmail(input)).toBe(input);
    },
  );
});

describe("cookies", () => {
  it("is httpOnly and lax, so script cannot read it and a link still works", () => {
    const cookie = sessionCookie("tok", { secure: true });
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Secure");
  });

  // Over plain http a Secure cookie is dropped, and development is plain http.
  it("omits Secure when the connection is not secure", () => {
    expect(sessionCookie("tok", { secure: false })).not.toContain("Secure");
  });

  it("clears with the same attributes, or the browser keeps the old one", () => {
    const cleared = clearedCookie({ secure: true });
    expect(cleared).toContain("Max-Age=0");
    expect(cleared).toContain("Path=/");
    expect(cleared).toContain("SameSite=Lax");
  });

  it("finds its own cookie among others", () => {
    const header = `other=1; ${SESSION_COOKIE}=abc123; another=2`;
    expect(readCookie(header, SESSION_COOKIE)).toBe("abc123");
  });

  it("is not confused by a name that merely ends the same way", () => {
    expect(readCookie(`not_bs_session=wrong; ${SESSION_COOKIE}=right`, SESSION_COOKIE)).toBe(
      "right",
    );
  });

  it("returns null for a missing or empty cookie", () => {
    expect(readCookie(undefined, SESSION_COOKIE)).toBeNull();
    expect(readCookie("other=1", SESSION_COOKIE)).toBeNull();
    expect(readCookie(`${SESSION_COOKIE}=`, SESSION_COOKIE)).toBeNull();
  });
});

describe("the sign-in email", () => {
  it("carries a link to the verify endpoint", () => {
    const { subject, body } = signInEmail("https://brandspace.app", "tok/with+chars");
    expect(subject).toMatch(/sign-in link/i);
    expect(body).toContain("https://brandspace.app/api/auth/verify?token=tok%2Fwith%2Bchars");
    expect(body).toContain(String(LINK_TTL_MINUTES));
  });
});

const suite = describe.skipIf(!hasDatabase);

suite("signing in [requires DATABASE_URL]", () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = await setupTestDatabase();
  }, 30_000);

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await resetBoard(pool);
    await pool.query(`TRUNCATE login_tokens, sessions RESTART IDENTITY CASCADE`);
  });

  it("creates an account on the way in, not when the link was asked for", async () => {
    const link = await requestSignInLink(pool, "new@example.com");

    const before = await countUsers(pool);
    expect(before).toBe(0);

    const signedIn = await consumeSignInLink(pool, link.token);
    expect(signedIn.created).toBe(true);
    expect(await countUsers(pool)).toBe(1);
  });

  it("signs the same person back into the same account", async () => {
    const first = await consumeSignInLink(pool, (await requestSignInLink(pool, "a@example.com")).token);
    const second = await consumeSignInLink(pool, (await requestSignInLink(pool, "a@example.com")).token);

    expect(second.created).toBe(false);
    expect(second.userId).toBe(first.userId);
    expect(await countUsers(pool)).toBe(1);
  });

  // Two accounts for one address means the second sign-in cannot see the first
  // one's planets, which is the worst possible day for a paying customer.
  it("treats a differently capitalised address as the same account", async () => {
    const first = await consumeSignInLink(pool, (await requestSignInLink(pool, "Sam@Example.com")).token);
    const second = await consumeSignInLink(pool, (await requestSignInLink(pool, "sam@example.com")).token);

    expect(second.userId).toBe(first.userId);
    expect(await countUsers(pool)).toBe(1);
  });

  it("gives back a working session", async () => {
    const link = await requestSignInLink(pool, "a@example.com");
    const signedIn = await consumeSignInLink(pool, link.token, "TestAgent/1.0");

    const user = await userForToken(pool, signedIn.session.token);
    expect(user?.id).toBe(signedIn.userId);
    expect(user?.email).toBe("a@example.com");
    expect(user?.isAdmin).toBe(false);
  });

  // The update that spends the token only matches an unconsumed row, so two
  // clicks arriving together cannot both win. Checking then updating would let
  // them.
  it("lets a link be used exactly once", async () => {
    const link = await requestSignInLink(pool, "a@example.com");

    await consumeSignInLink(pool, link.token);
    await expect(consumeSignInLink(pool, link.token)).rejects.toMatchObject({
      code: "bad_token",
      status: 401,
    });
  });

  it("lets exactly one of two simultaneous clicks in", async () => {
    const link = await requestSignInLink(pool, "a@example.com");

    const results = await Promise.allSettled([
      consumeSignInLink(pool, link.token),
      consumeSignInLink(pool, link.token),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  });

  it("refuses a link that has expired", async () => {
    const link = await requestSignInLink(pool, "a@example.com");
    await pool.query(
      `UPDATE login_tokens SET created_at = now() - interval '2 hours',
                              expires_at = now() - interval '1 hour'`,
    );

    await expect(consumeSignInLink(pool, link.token)).rejects.toMatchObject({ code: "bad_token" });
  });

  it("refuses a token nobody ever issued", async () => {
    await expect(consumeSignInLink(pool, "not-a-real-token")).rejects.toMatchObject({
      code: "bad_token",
    });
  });

  // Expired, spent and never-existed all give the same answer. Telling them
  // apart confirms to a stranger that a link once existed for that address.
  it("says the same thing however a token is wrong", async () => {
    const link = await requestSignInLink(pool, "a@example.com");
    await consumeSignInLink(pool, link.token);

    const used = await consumeSignInLink(pool, link.token).catch((error: unknown) => error);
    const never = await consumeSignInLink(pool, "nonsense").catch((error: unknown) => error);

    expect((used as Error).message).toBe((never as Error).message);
  });

  it("stops handing out links to one address forever", async () => {
    for (let i = 0; i < MAX_LINKS_PER_HOUR; i += 1) {
      await requestSignInLink(pool, "flood@example.com");
    }

    await expect(requestSignInLink(pool, "flood@example.com")).rejects.toMatchObject({
      code: "rate_limited",
      status: 429,
    });
  });

  it("rate limits per address, not across everyone", async () => {
    for (let i = 0; i < MAX_LINKS_PER_HOUR; i += 1) {
      await requestSignInLink(pool, "flood@example.com");
    }
    await expect(requestSignInLink(pool, "someone.else@example.com")).resolves.toBeDefined();
  });

  it("stores no token anybody could read back", async () => {
    const link = await requestSignInLink(pool, "a@example.com");

    const stored = await pool.query<{ token_hash: Buffer }>(`SELECT token_hash FROM login_tokens`);
    const hash = stored.rows[0]?.token_hash;
    expect(hash).toBeDefined();
    expect(hash?.toString("utf8")).not.toContain(link.token);
    expect(hash).toHaveLength(32);
  });
});

suite("sessions [requires DATABASE_URL]", () => {
  let pool: Pool;
  let userId: string;

  beforeAll(async () => {
    pool = await setupTestDatabase();
  }, 30_000);

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await resetBoard(pool);
    await pool.query(`TRUNCATE login_tokens, sessions RESTART IDENTITY CASCADE`);
    const result = await pool.query<{ id: string }>(
      `INSERT INTO users (email) VALUES ('owner@example.com') RETURNING id`,
    );
    userId = result.rows[0]?.id ?? "";
  });

  it("does not recognise a token it never issued", async () => {
    expect(await userForToken(pool, "made-up")).toBeNull();
    expect(await userForToken(pool, null)).toBeNull();
    expect(await userForToken(pool, "")).toBeNull();
  });

  it("stores the hash, never the token", async () => {
    const session = await startSession(pool, userId);

    const stored = await pool.query<{ token_hash: Buffer }>(`SELECT token_hash FROM sessions`);
    expect(stored.rows[0]?.token_hash.toString("utf8")).not.toContain(session.token);
    expect(stored.rows[0]?.token_hash).toHaveLength(32);
  });

  it("gives a different token every time, so signing in rotates it", async () => {
    const first = await startSession(pool, userId);
    const second = await startSession(pool, userId);
    expect(first.token).not.toBe(second.token);
  });

  it("stops recognising a session once it has expired", async () => {
    const session = await startSession(pool, userId);
    await pool.query(
      `UPDATE sessions SET created_at = now() - interval '60 days',
                           expires_at = now() - interval '1 second'`,
    );

    expect(await userForToken(pool, session.token)).toBeNull();
  });

  it("signing out makes the cookie worthless immediately", async () => {
    const session = await startSession(pool, userId);
    expect(await endSession(pool, session.token)).toBe(true);
    expect(await userForToken(pool, session.token)).toBeNull();
  });

  it("signs out everywhere, which is what a lost laptop needs", async () => {
    const a = await startSession(pool, userId);
    const b = await startSession(pool, userId);

    expect(await endAllSessions(pool, userId)).toBe(2);
    expect(await userForToken(pool, a.token)).toBeNull();
    expect(await userForToken(pool, b.token)).toBeNull();
  });

  it("leaves other people signed in when one person signs out", async () => {
    const other = await pool.query<{ id: string }>(
      `INSERT INTO users (email) VALUES ('other@example.com') RETURNING id`,
    );
    const mine = await startSession(pool, userId);
    const theirs = await startSession(pool, other.rows[0]?.id ?? "");

    await endAllSessions(pool, userId);

    expect(await userForToken(pool, mine.token)).toBeNull();
    expect(await userForToken(pool, theirs.token)).not.toBeNull();
  });

  it("sweeps expired rows and leaves live ones alone", async () => {
    const live = await startSession(pool, userId);
    await startSession(pool, userId);
    await pool.query(
      `UPDATE sessions SET created_at = now() - interval '60 days',
                           expires_at = now() - interval '1 day'
        WHERE token_hash <> $1`,
      [tokenHash(live.token)],
    );

    expect(await sweepSessions(pool)).toBe(1);
    expect(await userForToken(pool, live.token)).not.toBeNull();
  });

  it("deleting a user takes their sessions with them", async () => {
    const session = await startSession(pool, userId);
    await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);
    expect(await userForToken(pool, session.token)).toBeNull();
  });

  it("clears spent links after a day, and keeps fresh ones", async () => {
    await requestSignInLink(pool, "fresh@example.com");
    const old = await requestSignInLink(pool, "old@example.com");
    await consumeSignInLink(pool, old.token);
    await pool.query(`UPDATE login_tokens SET consumed_at = now() - interval '2 days'
                       WHERE consumed_at IS NOT NULL`);

    expect(await sweepSignInLinks(pool)).toBe(1);
  });
});

/** The same digest sessions.ts stores, so a test can point at one row. */
function tokenHash(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

async function countUsers(pool: Pool): Promise<number> {
  const result = await pool.query<{ count: string }>(`SELECT count(*)::text FROM users`);
  return Number(result.rows[0]?.count ?? 0);
}
