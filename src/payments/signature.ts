import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Webhook signature verification, in the Standard Webhooks scheme that Polar
 * uses.
 *
 * A webhook endpoint is a hole in the application that anyone on the internet
 * can post to, and what it posts decides whether a planet goes live or money
 * goes back. The signature is the only thing separating the provider from
 * everyone else, so this refuses by default: an unparseable header, a missing
 * secret, a stale timestamp and a wrong digest all return false.
 *
 * Three headers rather than one, and the id is inside the signed content, so a
 * delivery cannot be replayed as a different delivery. The scheme differs from
 * provider to provider only in how the parts are spelled; the checks below are
 * the ones that matter everywhere.
 */

export interface SignatureResult {
  readonly valid: boolean;
  /** Why it failed. For logs; never send this to the caller. */
  readonly reason?: string;
}

export interface VerifyOptions {
  /** The raw request bytes, exactly as received. A reparsed body will not match. */
  readonly rawBody: string;
  readonly id: string | undefined;
  readonly timestamp: string | undefined;
  /** Space separated list of `v1,<base64>`; any one matching is enough. */
  readonly signature: string | undefined;
  readonly secret: string | undefined;
  readonly toleranceSeconds?: number;
  readonly now?: number;
}

const DEFAULT_TOLERANCE_SECONDS = 300;

export function verifyWebhookSignature(options: VerifyOptions): SignatureResult {
  const { rawBody, id, timestamp, signature, secret } = options;
  const tolerance = options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  const now = options.now ?? Date.now();

  if (secret === undefined || secret === "") {
    return { valid: false, reason: "no signing secret is configured" };
  }
  if (id === undefined || timestamp === undefined || signature === undefined) {
    return { valid: false, reason: "request was missing one of the signature headers" };
  }

  const seconds = Number(timestamp);
  if (!Number.isFinite(seconds)) {
    return { valid: false, reason: "signature timestamp is not a number" };
  }

  // Replay protection. A valid signature would otherwise stay valid forever, so
  // a captured delivery could be replayed at any point in the future.
  const ageSeconds = Math.abs(now / 1000 - seconds);
  if (ageSeconds > tolerance) {
    return { valid: false, reason: `signature is ${Math.round(ageSeconds)}s out of date` };
  }

  const expected = sign(secret, id, timestamp, rawBody);

  // Providers send several versions during a key rotation, space separated.
  for (const candidate of signature.split(" ")) {
    const [version, value] = candidate.split(",");
    if (version !== "v1" || value === undefined) continue;
    if (equals(expected, value)) return { valid: true };
  }
  return { valid: false, reason: "signature does not match the body" };
}

/** The secret arrives base64 behind a prefix; the HMAC wants the raw bytes. */
function secretBytes(secret: string): Buffer {
  const withoutPrefix = secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret;
  const decoded = Buffer.from(withoutPrefix, "base64");
  // A secret that is not valid base64 is used as-is rather than as empty bytes,
  // which would make every signature verify against a zero-length key.
  return decoded.length > 0 ? decoded : Buffer.from(withoutPrefix, "utf8");
}

function sign(secret: string, id: string, timestamp: string, rawBody: string): string {
  return createHmac("sha256", secretBytes(secret))
    .update(`${id}.${timestamp}.${rawBody}`)
    .digest("base64");
}

/** Constant time, so a wrong digest cannot be found one character at a time. */
function equals(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  // timingSafeEqual throws on a length mismatch, which would itself leak length.
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * Builds the headers a provider would send. Used by tests and by anything
 * replaying a delivery locally; never on the request path.
 */
export function signPayload(
  rawBody: string,
  secret: string,
  id = "msg_test",
  atMs: number = Date.now(),
): { id: string; timestamp: string; signature: string } {
  const timestamp = String(Math.floor(atMs / 1000));
  return { id, timestamp, signature: `v1,${sign(secret, id, timestamp, rawBody)}` };
}
