import { writeFile } from "node:fs/promises";
import type { Pool } from "pg";
import sharp from "sharp";
import { DEFAULT_AURA, TRIAL_DAYS, isKnownAura } from "../config.js";
import { withTransaction } from "../db/client.js";

/**
 * Everything a creator supplies about their planet, and the trial that lets
 * them see it on the board before paying.
 *
 * The upload path is the part to be careful with. This is the one place where a
 * stranger's bytes reach an image library, and that library then renders them
 * into a public page. Nothing here trusts a filename, a content type, or a
 * declared size.
 */

export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;
export const STORED_AVATAR_PIXELS = 512;

/** Decoded pixels, not file size: this is what a decompression bomb attacks. */
const MAX_SOURCE_PIXELS = 40_000_000;
const MAX_SOURCE_SIDE = 12_000;
const ACCEPTED = new Set(["jpeg", "jpg", "png", "webp", "gif", "avif", "tiff"]);

export class UploadRejected extends Error {
  readonly status = 400;
  readonly code = "upload_rejected";

  constructor(message: string) {
    super(message);
    this.name = "UploadRejected";
  }
}

/**
 * Turns whatever arrived into one known-good square WebP.
 *
 * Re-encoding is the point. The output is a fresh image built from decoded
 * pixels, so anything hiding in the original container, metadata, or trailing
 * bytes does not survive the trip.
 */
export async function normaliseAvatar(bytes: Buffer): Promise<Buffer> {
  if (bytes.length === 0) throw new UploadRejected("The upload was empty.");
  if (bytes.length > MAX_UPLOAD_BYTES) {
    throw new UploadRejected(`Images must be ${MAX_UPLOAD_BYTES / 1024 / 1024}MB or smaller.`);
  }

  let meta;
  try {
    meta = await sharp(bytes).metadata();
  } catch {
    throw new UploadRejected("That file is not an image we can read.");
  }

  const format = meta.format ?? "";
  if (!ACCEPTED.has(format)) {
    throw new UploadRejected(`${format || "That file type"} is not supported.`);
  }

  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  if (width < 32 || height < 32) {
    throw new UploadRejected("That image is too small; 32 pixels square is the minimum.");
  }
  if (width > MAX_SOURCE_SIDE || height > MAX_SOURCE_SIDE) {
    throw new UploadRejected("That image is too large in dimensions.");
  }
  // A small file can still decode to an enormous bitmap.
  if (width * height > MAX_SOURCE_PIXELS) {
    throw new UploadRejected("That image decodes to too many pixels.");
  }

  return sharp(bytes, { animated: false })
    .resize(STORED_AVATAR_PIXELS, STORED_AVATAR_PIXELS, { fit: "cover", position: "attention" })
    .webp({ quality: 90 })
    .toBuffer();
}

/** Stores the normalised image beside the seeded ones and returns its URL. */
export async function storeAvatar(
  directory: URL,
  blockId: string,
  bytes: Buffer,
): Promise<{ imageUrl: string; storedBytes: number }> {
  const image = await normaliseAvatar(bytes);
  await writeFile(new URL(`${blockId}.webp`, directory), image);
  return { imageUrl: `/avatars/${blockId}.webp`, storedBytes: image.length };
}

// ---------------------------------------------------------------------------
// Listing detail
// ---------------------------------------------------------------------------

export interface ListingInput {
  readonly displayName?: string;
  readonly handle?: string;
  readonly primaryUrl?: string;
  readonly description?: string;
  readonly aura?: string;
  readonly imageUrl?: string;
}

export class ListingRejected extends Error {
  readonly status = 400;
  readonly code = "listing_rejected";

  constructor(message: string) {
    super(message);
    this.name = "ListingRejected";
  }
}

/**
 * A destination has to be somewhere a browser can go and nowhere else.
 *
 * javascript: and data: URLs in a link that a public page renders are the
 * cheapest possible XSS, so the scheme is checked against a list rather than
 * against a pattern of things to avoid.
 */
export function normaliseUrl(raw: string): string {
  const trimmed = raw.trim();
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    throw new ListingRejected("That does not look like a link.");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new ListingRejected("Links must start with https.");
  }
  if (parsed.hostname === "" || !parsed.hostname.includes(".")) {
    throw new ListingRejected("That link has no domain.");
  }
  return parsed.toString();
}

/**
 * Saves what the creator entered against every planet in their order.
 *
 * One listing covers the whole order: a planet is a creator's identity, and
 * someone buying two spots is buying two places to put the same face.
 */
export async function saveListing(
  pool: Pool,
  checkoutId: string,
  input: ListingInput,
): Promise<{ updated: number }> {
  const aura = input.aura ?? DEFAULT_AURA;
  if (!isKnownAura(aura)) throw new ListingRejected("That is not one of the auras.");

  const name = (input.displayName ?? "").trim();
  if (name.length === 0) throw new ListingRejected("A name is needed.");
  if (name.length > 60) throw new ListingRejected("That name is too long.");

  const description = (input.description ?? "").trim();
  if (description.length > 280) throw new ListingRejected("The description is too long.");

  const url = normaliseUrl(input.primaryUrl ?? "");

  const handle = (input.handle ?? name)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  if (handle.length < 2) throw new ListingRejected("That handle is too short.");

  return withTransaction(pool, async (tx) => {
    const blocks = await tx.query<{ id: string }>(
      `SELECT id FROM blocks WHERE checkout_session_id = $1 FOR UPDATE`,
      [checkoutId],
    );
    if (blocks.rows.length === 0) throw new ListingRejected("No such order.");

    // A handle has to be unique among visible planets, and the partial unique
    // index says so. Ask first, so the creator gets a sentence rather than a
    // constraint violation.
    const taken = await tx.query(
      `SELECT 1 FROM blocks
        WHERE lower(handle) = lower($1)
          AND status IN ('pending_review', 'live')
          AND checkout_session_id IS DISTINCT FROM $2
        LIMIT 1`,
      [handle, checkoutId],
    );
    if ((taken.rowCount ?? 0) > 0) {
      throw new ListingRejected(`The handle "${handle}" is taken.`);
    }

    const result = await tx.query(
      `UPDATE blocks
          SET display_name = $2,
              handle = $3,
              primary_url = $4,
              description = NULLIF($5, ''),
              aura = $6,
              image_url = COALESCE($7, image_url)
        WHERE checkout_session_id = $1`,
      [checkoutId, name, handle, url, description, aura, input.imageUrl ?? null],
    );
    return { updated: result.rowCount ?? 0 };
  });
}

// ---------------------------------------------------------------------------
// Free trial
// ---------------------------------------------------------------------------

export class TrialRefused extends Error {
  readonly status = 409;
  readonly code = "trial_refused";

  constructor(message: string) {
    super(message);
    this.name = "TrialRefused";
  }
}

/**
 * Puts an order into review without payment, for a few days.
 *
 * One per account, ever, recorded on the user rather than counted from their
 * planets: without that the trial is simply a way to hold tiles for nothing,
 * forever, by starting a new order every three days.
 *
 * The tiles stay held exactly as a paid order's would, and the same sweep that
 * releases a lapsed subscription releases these when the window closes.
 */
export async function startTrial(
  pool: Pool,
  userId: string,
  checkoutId: string,
): Promise<{ blocks: number; trialEndsAt: Date }> {
  return withTransaction(pool, async (tx) => {
    const user = await tx.query<{ trial_used_at: Date | null }>(
      `SELECT trial_used_at FROM users WHERE id = $1 FOR UPDATE`,
      [userId],
    );
    if (user.rows[0] === undefined) throw new TrialRefused("No such account.");
    if (user.rows[0].trial_used_at !== null) {
      throw new TrialRefused("This account has already had its free trial.");
    }

    const ready = await tx.query<{ id: string }>(
      `SELECT id FROM blocks
        WHERE checkout_session_id = $1 AND status = 'reserved'
        FOR UPDATE`,
      [checkoutId],
    );
    if (ready.rows.length === 0) {
      throw new TrialRefused("That order is no longer holding any tiles.");
    }

    const missing = await tx.query(
      `SELECT 1 FROM blocks
        WHERE checkout_session_id = $1
          AND (image_url IS NULL OR display_name IS NULL OR primary_url IS NULL)
        LIMIT 1`,
      [checkoutId],
    );
    if ((missing.rowCount ?? 0) > 0) {
      throw new TrialRefused("Add a photo, a name and a link before starting the trial.");
    }

    const updated = await tx.query<{ trial_ends_at: Date }>(
      `UPDATE blocks
          SET status = 'pending_review',
              reserved_until = NULL,
              trial_ends_at = now() + make_interval(days => $2::int)
        WHERE checkout_session_id = $1 AND status = 'reserved'
        RETURNING trial_ends_at`,
      [checkoutId, TRIAL_DAYS],
    );

    await tx.query(`UPDATE users SET trial_used_at = now() WHERE id = $1`, [userId]);

    const endsAt = updated.rows[0]?.trial_ends_at;
    if (endsAt === undefined) throw new TrialRefused("That order could not be started.");
    return { blocks: updated.rowCount ?? 0, trialEndsAt: endsAt };
  });
}
