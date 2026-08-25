import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Webhook signature verification.
 *
 * A webhook endpoint is a hole in the application that anyone on the internet
 * can post to, and what it posts decides whether a block goes live or money
 * goes back. The signature is the only thing separating the provider from
 * everyone else, so this refuses by default: an unparseable header, a missing
 * secret, a stale timestamp and a wrong digest all return false.
 *
 * The scheme here is Paddle's, which signs `timestamp:body`, but the shape is
 * the same everywhere and the checks below are the ones that matter regardless
 * of provider.
 */

export interface SignatureResult {
  readonly valid: boolean;
  /** Why it failed. For logs; never send this to the caller. */
  readonly reason?: string;
}

export interface VerifyOptions {
  /** The raw request bytes, exactly as received. A reparsed body will not match. */
  readonly rawBody: string;
  readonly header: string | undefined;
  readonly secret: string | undefined;
  /** How far out of date a delivery may be. Guards against replay. */
  readonly toleranceSeconds?: number;
  readonly now?: number;
}

const DEFAULT_TOLERANCE_SECONDS = 300;

export function verifyWebhookSignature(options: VerifyOptions): SignatureResult {
  const { rawBody, header, secret } = options;
  const tolerance = options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  const now = options.now ?? Date.now();

  if (secret === undefined || secret === "") {
    return { valid: false, reason: "no signing secret is configured" };
  }
  if (header === undefined || header === "") {
    return { valid: false, reason: "request carried no signature header" };
  }

  const parts = parseHeader(header);
  const ts = parts.get("ts");
  const digest = parts.get("h1");
  if (ts === undefined || digest === undefined) {
    return { valid: false, reason: "signature header is missing ts or h1" };
  }

  const seconds = Number(ts);
  if (!Number.isFinite(seconds)) {
    return { valid: false, reason: "signature timestamp is not a number" };
  }

  // Replay protection. A valid signature stays valid forever otherwise, so a
  // captured delivery could be replayed at any point in the future.
  const ageSeconds = Math.abs(now / 1000 - seconds);
  if (ageSeconds > tolerance) {
    return { valid: false, reason: `signature is ${Math.round(ageSeconds)}s out of date` };
  }

  const expected = createHmac("sha256", secret).update(`${ts}:${rawBody}`).digest("hex");
  if (!equals(expected, digest)) {
    return { valid: false, reason: "signature does not match the body" };
  }
  return { valid: true };
}

function parseHeader(header: string): Map<string, string> {
  const parts = new Map<string, string>();
  for (const segment of header.split(";")) {
    const index = segment.indexOf("=");
    if (index === -1) continue;
    parts.set(segment.slice(0, index).trim(), segment.slice(index + 1).trim());
  }
  return parts;
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
 * Builds a signature the way a provider would. Used by tests and by anything
 * replaying a delivery locally; never on the request path.
 */
export function signPayload(rawBody: string, secret: string, atMs: number = Date.now()): string {
  const ts = Math.floor(atMs / 1000);
  const digest = createHmac("sha256", secret).update(`${ts}:${rawBody}`).digest("hex");
  return `ts=${ts};h1=${digest}`;
}
