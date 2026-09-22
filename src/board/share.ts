import type { Pool } from "pg";
import sharp from "sharp";
import { AURAS, DEFAULT_AURA, orbitAt } from "../config.js";
import { renderPlanet } from "./composite.js";
import type { AvatarStore } from "./composite.js";

export type { AvatarStore };

/**
 * Share cards and embed badges.
 *
 * Nobody shares a link to a directory. They share a link to themselves, and
 * what gets seen is whatever the card unfurls into. So the card is the planet,
 * not the board: their face, their name, their orbit, on black.
 *
 * It is also the cheapest distribution this product has. Every owner who puts
 * the badge on their own site is a link back that we did not have to buy, and
 * every card that unfurls in a post is an advert with a real person in it.
 */

/** The size every social network crops to, so nothing important is near an edge. */
export const CARD_WIDTH = 1200;
export const CARD_HEIGHT = 630;

const PLANET_DIAMETER = 340;

export interface ShareSubject {
  readonly id: string;
  readonly displayName: string;
  readonly handle: string;
  readonly description: string | null;
  readonly imageUrl: string | null;
  readonly aura: string;
  readonly x: number;
  readonly y: number;
  readonly size: number;
  readonly clicks: number;
}

/**
 * Anything that goes into an SVG has to be escaped.
 *
 * Display names and descriptions are typed by strangers and rendered into
 * markup. A name containing a closing tag would otherwise stop being a name and
 * start being part of the document.
 */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Cuts text to fit, in characters rather than in measured pixels.
 *
 * A real text measurement would need the font metrics, and the card is
 * deliberately built without a font dependency: it uses whatever sans-serif the
 * rasteriser has. So the limits are conservative enough that the widest
 * plausible string still fits.
 */
function fit(value: string, limit: number): string {
  const text = value.trim().replace(/\s+/g, " ");
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

function auraRgb(name: string): string {
  const aura = AURAS.find((candidate) => candidate.name === name);
  return (aura ?? AURAS.find((candidate) => candidate.name === DEFAULT_AURA))?.rgb ?? "96, 165, 250";
}

/**
 * The stars behind the planet.
 *
 * Seeded from the planet's own id so a given card always looks the same. A card
 * that reshuffled its stars every time it was fetched would produce a different
 * image on every scrape, which is both wasteful and slightly unsettling.
 */
function starfield(seed: string, count = 90): string {
  let state = 0;
  for (const character of seed) state = (state * 31 + character.charCodeAt(0)) >>> 0;

  const next = (): number => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 0xffff_ffff;
  };

  const stars: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const cx = Math.round(next() * CARD_WIDTH);
    const cy = Math.round(next() * CARD_HEIGHT);
    const r = (next() * 1.6 + 0.3).toFixed(2);
    const opacity = (next() * 0.6 + 0.15).toFixed(2);
    stars.push(`<circle cx="${cx}" cy="${cy}" r="${r}" fill="#fff" opacity="${opacity}"/>`);
  }
  return stars.join("");
}

/** The card without the avatar: background, aura, and every piece of text. */
function cardBackdrop(subject: ShareSubject): Buffer {
  const rgb = auraRgb(subject.aura);
  const orbit = orbitAt(subject.x, subject.y);
  const planetX = 200 + PLANET_DIAMETER / 2;
  const planetY = CARD_HEIGHT / 2;

  const name = escapeXml(fit(subject.displayName, 26));
  const handle = escapeXml(fit(`@${subject.handle}`, 28));
  const blurb = subject.description === null ? "" : escapeXml(fit(subject.description, 58));
  const where = escapeXml(`${orbit?.label ?? "The void"} · ${subject.size}×${subject.size}`);
  const clicks =
    subject.clicks > 0 ? escapeXml(`${subject.clicks.toLocaleString("en")} clicks`) : "";

  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_WIDTH}" height="${CARD_HEIGHT}">
       <defs>
         <radialGradient id="aura" cx="50%" cy="50%" r="50%">
           <stop offset="55%" stop-color="rgb(${rgb})" stop-opacity="0.55"/>
           <stop offset="100%" stop-color="rgb(${rgb})" stop-opacity="0"/>
         </radialGradient>
         <linearGradient id="deep" x1="0" y1="0" x2="1" y2="1">
           <stop offset="0%" stop-color="#05070f"/>
           <stop offset="100%" stop-color="#01020a"/>
         </linearGradient>
       </defs>

       <rect width="${CARD_WIDTH}" height="${CARD_HEIGHT}" fill="url(#deep)"/>
       ${starfield(subject.id)}
       <circle cx="${planetX}" cy="${planetY}" r="${PLANET_DIAMETER * 0.85}" fill="url(#aura)"/>

       <text x="620" y="252" fill="#ffffff" font-size="64" font-weight="700"
             font-family="Helvetica, Arial, sans-serif">${name}</text>
       <text x="620" y="312" fill="rgb(${rgb})" font-size="34"
             font-family="Helvetica, Arial, sans-serif">${handle}</text>
       <text x="620" y="376" fill="#9fb0cc" font-size="26"
             font-family="Helvetica, Arial, sans-serif">${blurb}</text>

       <text x="620" y="470" fill="#6f819e" font-size="22" letter-spacing="2"
             font-family="Helvetica, Arial, sans-serif">${where.toUpperCase()}</text>
       <text x="620" y="506" fill="#6f819e" font-size="22" letter-spacing="2"
             font-family="Helvetica, Arial, sans-serif">${clicks.toUpperCase()}</text>

       <text x="620" y="566" fill="#44557a" font-size="20" letter-spacing="4"
             font-family="Helvetica, Arial, sans-serif">BRANDSPACE</text>
     </svg>`,
  );
}

/**
 * The card, as a PNG.
 *
 * PNG rather than WebP because this is read by other people's scrapers, and the
 * ones that matter have supported PNG for twenty years and WebP for rather
 * fewer.
 */
export async function renderShareCard(
  subject: ShareSubject,
  avatars: AvatarStore,
): Promise<Buffer> {
  const backdrop = sharp(cardBackdrop(subject));

  if (subject.imageUrl === null) return backdrop.png().toBuffer();

  let planet: Buffer;
  try {
    planet = await renderPlanet(await avatars.read(subject.imageUrl), PLANET_DIAMETER);
  } catch {
    // A missing avatar is not a reason to serve no card at all.
    return backdrop.png().toBuffer();
  }

  return backdrop
    .composite([{ input: planet, left: 200, top: Math.round((CARD_HEIGHT - PLANET_DIAMETER) / 2) }])
    .png()
    .toBuffer();
}

export const BADGE_WIDTH = 210;
export const BADGE_HEIGHT = 40;

/**
 * The badge an owner puts on their own site.
 *
 * SVG so it stays sharp wherever it lands and needs no rasterising on our side,
 * and small enough that nobody hesitates to paste it into a footer.
 */
export function renderBadge(subject: ShareSubject): string {
  const rgb = auraRgb(subject.aura);
  const handle = escapeXml(fit(`@${subject.handle}`, 18));

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${BADGE_WIDTH}" height="${BADGE_HEIGHT}"
     viewBox="0 0 ${BADGE_WIDTH} ${BADGE_HEIGHT}" role="img"
     aria-label="${handle} on BrandSpace">
  <rect width="${BADGE_WIDTH}" height="${BADGE_HEIGHT}" rx="8" fill="#05070f"/>
  <rect width="${BADGE_WIDTH}" height="${BADGE_HEIGHT}" rx="8" fill="none"
        stroke="rgb(${rgb})" stroke-opacity="0.45"/>
  <circle cx="24" cy="20" r="9" fill="rgb(${rgb})" fill-opacity="0.9"/>
  <circle cx="24" cy="20" r="14" fill="rgb(${rgb})" fill-opacity="0.16"/>
  <text x="46" y="17" fill="#6f819e" font-size="9" letter-spacing="2"
        font-family="Helvetica, Arial, sans-serif">BRANDSPACE</text>
  <text x="46" y="31" fill="#ffffff" font-size="13" font-weight="600"
        font-family="Helvetica, Arial, sans-serif">${handle}</text>
</svg>`;
}

/**
 * The snippet an owner copies.
 *
 * An anchor and an image rather than an iframe: an iframe cannot be styled by
 * the page it sits in, is blocked by a fair number of content policies, and
 * carries no link for a crawler to follow. The whole point of the badge is the
 * link.
 */
export function embedSnippet(origin: string, subject: ShareSubject): string {
  const handle = escapeXml(subject.handle);
  return (
    `<a href="${escapeXml(origin)}/b/${handle}" target="_blank" rel="noopener">` +
    `<img src="${escapeXml(origin)}/badge/${subject.id}.svg" ` +
    `width="${BADGE_WIDTH}" height="${BADGE_HEIGHT}" ` +
    `alt="@${handle} on BrandSpace" loading="lazy"></a>`
  );
}

/**
 * The listing page's markup.
 *
 * This is the SEO surface: one page per planet, with the card in its meta tags
 * so a shared link unfurls into the planet rather than into nothing.
 *
 * The outbound link carries rel="nofollow sponsored noopener". Sponsored
 * because it is: the placement is paid for, and search engines are explicit
 * that a paid link which passes ranking is a problem for the site being linked
 * to. Selling do-follow links would be selling our customers a penalty.
 */
export function listingPage(origin: string, subject: ShareSubject): string {
  const name = escapeXml(subject.displayName);
  const handle = escapeXml(subject.handle);
  const blurb = escapeXml(subject.description ?? `${subject.displayName} on BrandSpace.`);
  const card = `${escapeXml(origin)}/card/${subject.id}.png`;
  const orbit = orbitAt(subject.x, subject.y);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${name} (@${handle}) on BrandSpace</title>
<meta name="description" content="${blurb}">
<link rel="canonical" href="${escapeXml(origin)}/b/${handle}">

<meta property="og:type" content="profile">
<meta property="og:title" content="${name} (@${handle})">
<meta property="og:description" content="${blurb}">
<meta property="og:image" content="${card}">
<meta property="og:image:width" content="${CARD_WIDTH}">
<meta property="og:image:height" content="${CARD_HEIGHT}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${name} (@${handle})">
<meta name="twitter:description" content="${blurb}">
<meta name="twitter:image" content="${card}">

<style>
  :root { color-scheme: dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center;
         background: #05070f; color: #e6edf9;
         font-family: Helvetica, Arial, sans-serif; }
  main { text-align: center; padding: 32px; max-width: 560px; }
  img.card { width: 100%; height: auto; border-radius: 16px; }
  h1 { font-size: 28px; margin: 24px 0 4px; }
  p.handle { color: #6f819e; margin: 0 0 20px; }
  p.blurb { color: #9fb0cc; line-height: 1.5; }
  a.go { display: inline-block; margin-top: 20px; padding: 12px 22px; border-radius: 10px;
         background: #1b2742; color: #e6edf9; text-decoration: none; }
  a.back { display: block; margin-top: 28px; color: #44557a; font-size: 14px; }
</style>
</head>
<body>
<main>
  <img class="card" src="${card}" alt="${name} on BrandSpace" width="${CARD_WIDTH}" height="${CARD_HEIGHT}">
  <h1>${name}</h1>
  <p class="handle">@${handle} &middot; ${escapeXml(orbit?.label ?? "The void")}</p>
  <p class="blurb">${blurb}</p>
  <a class="go" href="/go/${subject.id}" rel="nofollow sponsored noopener">Visit</a>
  <a class="back" href="/">Back to the universe</a>
</main>
</body>
</html>`;
}

/** Loads a planet by id or by handle. Only live planets have a public page. */
export async function shareSubject(
  pool: Pool,
  by: { id: string } | { handle: string },
): Promise<ShareSubject | null> {
  const where = "id" in by ? "id = $1" : "lower(handle) = lower($1)";
  const value = "id" in by ? by.id : by.handle;

  const result = await pool.query<{
    id: string;
    display_name: string;
    handle: string;
    description: string | null;
    image_url: string | null;
    aura: string;
    x: number;
    y: number;
    size: number;
    click_count: number;
  }>(
    `SELECT id, display_name, handle, description, image_url, aura, x, y, size, click_count
       FROM blocks
      WHERE ${where} AND status = 'live'`,
    [value],
  );

  const row = result.rows[0];
  if (row === undefined) return null;

  return {
    id: row.id,
    displayName: row.display_name,
    handle: row.handle,
    description: row.description,
    imageUrl: row.image_url,
    aura: row.aura,
    x: row.x,
    y: row.y,
    size: row.size,
    clicks: row.click_count,
  };
}
