import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Pool } from "pg";
import type { Queryable } from "../db/client.js";

/**
 * Sessions.
 *
 * The cookie holds a random token; the database holds only its SHA-256. That
 * asymmetry is the whole design: a dump of the sessions table contains nothing
 * anybody can present as a session, in the same way a dump of a password table
 * should contain nothing anybody can type.
 *
 * There is no JWT here on purpose. A signed token that cannot be revoked is a
 * liability on a product that takes money: signing out has to actually sign
 * out, and a stolen cookie has to be killable from our side.
 */

/** 256 bits. Long enough that guessing is not a strategy. */
const TOKEN_BYTES = 32;

export const SESSION_COOKIE = "bs_session";

/**
 * How long a session lasts, absolutely.
 *
 * Absolute rather than sliding: a sliding window can be kept alive forever by
 * whoever holds the cookie, which is exactly the person you do not want holding
 * it if it was stolen.
 */
export const SESSION_DAYS = 30;

/** Writing last_used_at on every request would be a write per page view. */
const TOUCH_AFTER_MS = 6 * 60 * 60 * 1000;

export interface SessionUser {
  readonly id: string;
  readonly email: string | null;
  readonly handle: string | null;
  readonly displayName: string | null;
  readonly avatarUrl: string | null;
  readonly isAdmin: boolean;
}

export interface StartedSession {
  /** Goes in the cookie. This is the only time it exists in readable form. */
  readonly token: string;
  readonly expiresAt: Date;
}

function hash(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

export function newToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

/**
 * Starts a session for a user.
 *
 * Callers sign in by calling this, which means a sign-in always produces a new
 * token: there is no path that reuses one. That is what "rotate on sign-in"
 * means, and it is what stops a token fixed before sign-in from being valid
 * after it.
 */
export async function startSession(
  db: Queryable,
  userId: string,
  userAgent?: string | null,
): Promise<StartedSession> {
  const token = newToken();
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86_400_000);

  await db.query(
    `INSERT INTO sessions (user_id, token_hash, expires_at, user_agent)
     VALUES ($1, $2, $3, $4)`,
    [userId, hash(token), expiresAt, userAgent?.slice(0, 300) ?? null],
  );

  await db.query(`UPDATE users SET last_seen_at = now() WHERE id = $1`, [userId]);
  return { token, expiresAt };
}

/**
 * Who this token belongs to, or null.
 *
 * The expiry is checked in the query rather than in JavaScript, so a clock that
 * disagrees cannot extend a session, and an expired row is never returned even
 * if the sweep has not got to it yet.
 */
export async function userForToken(pool: Pool, token: string | null): Promise<SessionUser | null> {
  if (token === null || token === "") return null;

  const result = await pool.query<{
    session_id: string;
    last_used_at: Date;
    id: string;
    email: string | null;
    x_handle: string | null;
    display_name: string | null;
    avatar_url: string | null;
    is_admin: boolean;
  }>(
    `SELECT s.id AS session_id, s.last_used_at,
            u.id, u.email, u.x_handle, u.display_name, u.avatar_url, u.is_admin
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [hash(token)],
  );

  const row = result.rows[0];
  if (row === undefined) return null;

  // Cheap freshness, so a list of sessions is not all showing the sign-in date.
  if (Date.now() - row.last_used_at.getTime() > TOUCH_AFTER_MS) {
    await pool
      .query(`UPDATE sessions SET last_used_at = now() WHERE id = $1`, [row.session_id])
      .catch(() => undefined);
  }

  return {
    id: row.id,
    email: row.email,
    handle: row.x_handle,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
    isAdmin: row.is_admin,
  };
}

/** Signing out. Deletes the row, so the cookie is worthless from here on. */
export async function endSession(pool: Pool, token: string | null): Promise<boolean> {
  if (token === null || token === "") return false;
  const result = await pool.query(`DELETE FROM sessions WHERE token_hash = $1`, [hash(token)]);
  return (result.rowCount ?? 0) > 0;
}

/** Signing out everywhere, which is what someone wants after losing a laptop. */
export async function endAllSessions(pool: Pool, userId: string): Promise<number> {
  const result = await pool.query(`DELETE FROM sessions WHERE user_id = $1`, [userId]);
  return result.rowCount ?? 0;
}

/** Expired rows are dead weight and a privacy liability. Run this on a timer. */
export async function sweepSessions(pool: Pool): Promise<number> {
  const result = await pool.query(`DELETE FROM sessions WHERE expires_at < now()`);
  return result.rowCount ?? 0;
}

// ---------------------------------------------------------------------------
// Cookies
// ---------------------------------------------------------------------------

export interface CookieOptions {
  /** Secure is omitted over plain http, or the browser drops the cookie. */
  readonly secure: boolean;
  readonly maxAgeSeconds?: number;
}

/**
 * The Set-Cookie for a session.
 *
 * httpOnly so script cannot read it, which is what makes a cross-site scripting
 * bug fall short of being a full account takeover. SameSite=Lax rather than
 * Strict so that following a sign-in link from an email arrives signed in,
 * which is the entire point of a sign-in link.
 */
export function sessionCookie(token: string, options: CookieOptions): string {
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${options.maxAgeSeconds ?? SESSION_DAYS * 86_400}`,
  ];
  if (options.secure) parts.push("Secure");
  return parts.join("; ");
}

/** The Set-Cookie that removes it. Same attributes, or the browser keeps it. */
export function clearedCookie(options: CookieOptions): string {
  const parts = [`${SESSION_COOKIE}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  if (options.secure) parts.push("Secure");
  return parts.join("; ");
}

/**
 * Pulls one cookie out of a Cookie header.
 *
 * Written by hand rather than pulled in, because the header is a short, well
 * specified string and this is the entire surface we need from it. Values are
 * left as-is apart from trimming: a session token is base64url and contains
 * nothing that needs decoding.
 */
export function readCookie(header: string | undefined, name: string): string | null {
  if (header === undefined) return null;

  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    if (part.slice(0, index).trim() !== name) continue;
    const value = part.slice(index + 1).trim();
    return value === "" ? null : value;
  }
  return null;
}

/**
 * Constant-time string comparison, for anywhere a caller-supplied value is
 * checked against a secret.
 */
export function secureEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
