import { createHash } from "node:crypto";
import sharp from "sharp";
import { TILE_INSET, TILE_PIXELS } from "../config.js";

/** Sensible default when no block size is known. */
export const AVATAR_PIXELS = 160;

/** Rendered size of a block's avatar, capped so a huge block is not a huge file. */
export function avatarPixelsFor(size: number): number {
  return Math.min(512, size * TILE_PIXELS - 2 * TILE_INSET);
}

/**
 * Stand-in avatars for seeded blocks, generated rather than downloaded so the
 * dev board works offline. Real listings upload their own (step 4); this only
 * has to be deterministic and visually distinct.
 */
export async function generateAvatar(
  handle: string,
  initials: string,
  pixels: number = AVATAR_PIXELS,
): Promise<Buffer> {
  const hash = createHash("sha1").update(handle).digest();
  const hue = ((hash[0] ?? 0) / 255) * 360;
  const hue2 = (hue + 40 + ((hash[1] ?? 0) / 255) * 80) % 360;

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${pixels}" height="${pixels}">
    <defs>
      <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="hsl(${hue.toFixed(0)} 72% 58%)"/>
        <stop offset="100%" stop-color="hsl(${hue2.toFixed(0)} 68% 38%)"/>
      </linearGradient>
    </defs>
    <rect width="100%" height="100%" fill="url(#g)"/>
    <text x="50%" y="50%" dy="0.35em" text-anchor="middle"
          font-family="Arial, Helvetica, sans-serif"
          font-size="${Math.round(pixels * 0.42)}"
          font-weight="700" fill="rgba(255,255,255,0.92)">${escapeXml(initials)}</text>
  </svg>`;

  return sharp(Buffer.from(svg)).webp({ quality: 90 }).toBuffer();
}

function escapeXml(value: string): string {
  return value.replace(/[<>&'"]/g, (c) => {
    switch (c) {
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case "&":
        return "&amp;";
      case "'":
        return "&apos;";
      default:
        return "&quot;";
    }
  });
}
