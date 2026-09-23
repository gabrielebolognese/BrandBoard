import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { withTransaction } from "../db/client.js";
import { newToken, startSession } from "./sessions.js";
import type { StartedSession } from "./sessions.js";

/**
 * Signing in with an emailed link.
 *
 * No passwords, which means no password to store, no password to leak, no reset
 * flow, and nothing for someone to reuse from another site. The tradeoff is
 * that the email account becomes the account, which is true of password reset
 * anyway.
 *
 * The token goes in the email and its SHA-256 goes in the database, exactly as
 * for sessions. A leaked table full of hashes cannot be turned back into links.
 */

/** Long enough to click, short enough that a forwarded email goes stale. */
export const LINK_TTL_MINUTES = 15;

/** Per address, per hour. Enough for a few mistyped attempts, not for a flood. */
export const MAX_LINKS_PER_HOUR = 5;

export class SignInRefused extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, code: string, status: number) {
    super(message);
    this.name = "SignInRefused";
    this.code = code;
    this.status = status;
  }
}

function hash(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

/**
 * Whether this is plausibly an email address.
 *
 * Deliberately loose. The real test of an address is whether a message to it
 * arrives, and every attempt to decide it with a pattern rejects somebody's
 * perfectly valid address. This only rejects what cannot be delivered to at
 * all.
 */
export function normaliseEmail(raw: string): string {
  const email = raw.trim().toLowerCase();

  if (email.length < 3 || email.length > 254) {
    throw new SignInRefused("That does not look like an email address.", "bad_email", 400);
  }
  const at = email.indexOf("@");
  if (at <= 0 || at !== email.lastIndexOf("@") || at === email.length - 1) {
    throw new SignInRefused("That does not look like an email address.", "bad_email", 400);
  }
  if (!email.slice(at + 1).includes(".") || /\s/.test(email)) {
    throw new SignInRefused("That does not look like an email address.", "bad_email", 400);
  }
  return email;
}

export interface RequestedLink {
  readonly email: string;
  /** Put this in the email. It is never stored and cannot be read back. */
  readonly token: string;
  readonly expiresAt: Date;
}

/**
 * Issues a sign-in link.
 *
 * Note what this does not do: it does not tell the caller whether the address
 * has an account. Whether someone is a customer is not a fact this endpoint
 * gets to disclose to anyone who can type an address into it, so the answer is
 * the same either way and the account is created on the way back in, not here.
 */
export async function requestSignInLink(
  pool: Pool,
  rawEmail: string,
  ipHash?: Buffer | null,
): Promise<RequestedLink> {
  const email = normaliseEmail(rawEmail);

  const recent = await pool.query<{ count: string }>(
    `SELECT count(*)::text FROM login_tokens
      WHERE lower(email) = $1 AND created_at > now() - interval '1 hour'`,
    [email],
  );

  if (Number(recent.rows[0]?.count ?? 0) >= MAX_LINKS_PER_HOUR) {
    throw new SignInRefused(
      "That address has been sent several links already. Try again in an hour.",
      "rate_limited",
      429,
    );
  }

  const token = newToken();
  const expiresAt = new Date(Date.now() + LINK_TTL_MINUTES * 60_000);

  await pool.query(
    `INSERT INTO login_tokens (email, token_hash, expires_at, requested_ip_hash)
     VALUES ($1, $2, $3, $4)`,
    [email, hash(token), expiresAt, ipHash ?? null],
  );

  return { email, token, expiresAt };
}

export interface SignedIn {
  readonly userId: string;
  readonly email: string;
  readonly created: boolean;
  readonly session: StartedSession;
}

/**
 * Spends a link and signs the person in.
 *
 * All of it in one transaction, and the token is consumed by an UPDATE that
 * only matches an unconsumed row. Two clicks arriving together therefore
 * cannot both succeed: the second one updates nothing and is told the link has
 * been used. Checking first and updating after would let both through.
 *
 * The account is created here rather than when the link was requested, so that
 * asking for a link for an address that has never been used leaves nothing
 * behind.
 */
export async function consumeSignInLink(
  pool: Pool,
  token: string,
  userAgent?: string | null,
): Promise<SignedIn> {
  if (token === "") {
    throw new SignInRefused("That link is not valid.", "bad_token", 400);
  }

  return withTransaction(pool, async (tx) => {
    const spent = await tx.query<{ id: string; email: string }>(
      `UPDATE login_tokens
          SET consumed_at = now()
        WHERE token_hash = $1
          AND consumed_at IS NULL
          AND expires_at > now()
        RETURNING id, email`,
      [hash(token)],
    );

    const row = spent.rows[0];
    if (row === undefined) {
      // One message for expired, already used, and never existed. Telling them
      // apart would confirm to a stranger that a link once existed.
      throw new SignInRefused(
        "That link has expired or has already been used. Ask for another.",
        "bad_token",
        401,
      );
    }

    const email = row.email.toLowerCase();

    // ON CONFLICT against the case-insensitive index from migration 003, so
    // signing in twice with different capitalisation is one account.
    const upserted = await tx.query<{ id: string; created: boolean }>(
      `INSERT INTO users (email) VALUES ($1)
       ON CONFLICT (lower(email)) WHERE email IS NOT NULL
       DO UPDATE SET last_seen_at = now()
       RETURNING id, (xmax = 0) AS created`,
      [email],
    );

    const user = upserted.rows[0];
    if (user === undefined) throw new Error("sign-in upsert returned no row");

    const session = await startSession(tx, user.id, userAgent);
    return { userId: user.id, email, created: user.created, session };
  });
}

/** Expired and spent links are dead weight and a record of who signed in when. */
export async function sweepSignInLinks(pool: Pool): Promise<number> {
  const result = await pool.query(
    `DELETE FROM login_tokens
      WHERE expires_at < now() - interval '1 day'
         OR consumed_at < now() - interval '1 day'`,
  );
  return result.rowCount ?? 0;
}

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

export interface Mailer {
  send(to: string, subject: string, body: string): Promise<void>;
}

/**
 * Where a link is sent when no email provider is configured.
 *
 * It goes to the server log and nowhere else. A tempting alternative is to
 * return it in the HTTP response so the development flow is one click, and that
 * is exactly the shape of thing that survives into production and turns the
 * endpoint into "type an address, receive their session". It is not worth the
 * convenience, so the link is printed where only someone with the server can
 * read it.
 */
export function consoleMailer(): Mailer {
  return {
    send(to, subject, body) {
      console.log(`\n  [mail] to ${to}: ${subject}\n  ${body}\n`);
      return Promise.resolve();
    },
  };
}

export function signInEmail(origin: string, token: string): { subject: string; body: string } {
  const link = `${origin}/api/auth/verify?token=${encodeURIComponent(token)}`;
  return {
    subject: "Your BrandSpace sign-in link",
    body:
      `Sign in: ${link}\n\n` +
      `The link works once and expires in ${LINK_TTL_MINUTES} minutes. ` +
      `If you did not ask for it, nothing has happened and you can ignore this.`,
  };
}
