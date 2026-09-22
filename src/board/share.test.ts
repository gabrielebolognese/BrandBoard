import type { Pool } from "pg";
import sharp from "sharp";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  CARD_HEIGHT,
  CARD_WIDTH,
  embedSnippet,
  escapeXml,
  listingPage,
  renderBadge,
  renderShareCard,
  shareSubject,
} from "./share.js";
import type { AvatarStore, ShareSubject } from "./share.js";
import { createTestUser, hasDatabase, resetBoard, setupTestDatabase } from "../test/db.js";

const subject: ShareSubject = {
  id: "8b46acab-843d-4e17-bb67-27868122665b",
  displayName: "Rui Bishop",
  handle: "ruibishop",
  description: "Weekly essays on typography",
  imageUrl: null,
  aura: "violet",
  x: 150,
  y: 150,
  size: 3,
  clicks: 1234,
};

/** A one pixel PNG is enough to prove the avatar path runs. */
async function tinyAvatar(): Promise<Buffer> {
  return sharp({
    create: { width: 8, height: 8, channels: 4, background: { r: 200, g: 40, b: 90, alpha: 1 } },
  })
    .png()
    .toBuffer();
}

describe("escaping", () => {
  // Display names are typed by strangers and rendered into markup. A name that
  // can close a tag stops being a name and starts being part of the document.
  it("neutralises markup in a name", () => {
    expect(escapeXml('</text><script>alert(1)</script>')).toBe(
      "&lt;/text&gt;&lt;script&gt;alert(1)&lt;/script&gt;",
    );
  });

  it("escapes quotes, which is what attributes are held together by", () => {
    expect(escapeXml('a"b\'c&d')).toBe("a&quot;b&apos;c&amp;d");
  });
});

describe("the share card", () => {
  it("renders at the size every network crops to", async () => {
    const png = await renderShareCard(subject, emptyStore());
    const meta = await sharp(png).metadata();

    expect(meta.format).toBe("png");
    expect(meta.width).toBe(CARD_WIDTH);
    expect(meta.height).toBe(CARD_HEIGHT);
  });

  it("puts the avatar on the card when there is one", async () => {
    const avatar = await tinyAvatar();
    const store: AvatarStore = { read: async () => avatar };

    const withPlanet = await renderShareCard({ ...subject, imageUrl: "a.webp" }, store);
    const without = await renderShareCard(subject, emptyStore());

    expect(withPlanet.equals(without)).toBe(false);
  });

  // A missing file on disk is not a reason to serve no card at all: the card is
  // fetched by someone else's scraper, and a 500 there means a bare link.
  it("still renders when the avatar cannot be read", async () => {
    const store: AvatarStore = { read: () => Promise.reject(new Error("ENOENT")) };

    const png = await renderShareCard({ ...subject, imageUrl: "gone.webp" }, store);
    expect((await sharp(png).metadata()).width).toBe(CARD_WIDTH);
  });

  // Seeded from the id, so a scraper refetching gets the same bytes rather than
  // a freshly reshuffled sky.
  it("draws the same card twice for the same planet", async () => {
    const first = await renderShareCard(subject, emptyStore());
    const second = await renderShareCard(subject, emptyStore());
    expect(first.equals(second)).toBe(true);
  });

  it("draws a different sky for a different planet", async () => {
    const other = { ...subject, id: "11111111-2222-3333-4444-555555555555" };
    const first = await renderShareCard(subject, emptyStore());
    const second = await renderShareCard(other, emptyStore());
    expect(first.equals(second)).toBe(false);
  });

  it("survives a name that is trying to break out of the SVG", async () => {
    const hostile = { ...subject, displayName: '"><script>alert(1)</script>' };
    const png = await renderShareCard(hostile, emptyStore());
    expect((await sharp(png).metadata()).width).toBe(CARD_WIDTH);
  });

  it("renders a planet with no description at all", async () => {
    const png = await renderShareCard({ ...subject, description: null }, emptyStore());
    expect((await sharp(png).metadata()).height).toBe(CARD_HEIGHT);
  });
});

describe("the badge", () => {
  it("is an SVG carrying the handle", () => {
    const svg = renderBadge(subject);
    expect(svg).toContain("<svg");
    expect(svg).toContain("@ruibishop");
    expect(svg).toContain("BRANDSPACE");
  });

  it("escapes a hostile handle rather than emitting it", () => {
    const svg = renderBadge({ ...subject, handle: '"><script>' });
    expect(svg).not.toContain("<script>");
    expect(svg).toContain("&lt;script&gt;");
  });
});

describe("the embed snippet", () => {
  it("is a link wrapping an image, so a crawler has something to follow", () => {
    const snippet = embedSnippet("https://brandspace.app", subject);

    expect(snippet).toContain('href="https://brandspace.app/b/ruibishop"');
    expect(snippet).toContain('src="https://brandspace.app/badge/');
    expect(snippet).not.toContain("<iframe");
  });
});

describe("the listing page", () => {
  it("carries the card in the tags a scraper reads", () => {
    const html = listingPage("https://brandspace.app", subject);

    expect(html).toContain('property="og:image"');
    expect(html).toContain(`/card/${subject.id}.png`);
    expect(html).toContain('name="twitter:card" content="summary_large_image"');
    expect(html).toContain(`<meta property="og:image:width" content="${CARD_WIDTH}">`);
  });

  // Selling a link that passes ranking is selling the buyer a penalty, so the
  // outbound link says what it is.
  it("marks the outbound link as paid", () => {
    const html = listingPage("https://brandspace.app", subject);
    expect(html).toContain('rel="nofollow sponsored noopener"');
  });

  it("sends the click through the counter rather than straight out", () => {
    const html = listingPage("https://brandspace.app", subject);
    expect(html).toContain(`href="/go/${subject.id}"`);
  });

  it("escapes a hostile description instead of rendering it", () => {
    const html = listingPage("https://brandspace.app", {
      ...subject,
      description: '"><script>alert(1)</script>',
    });

    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

const suite = describe.skipIf(!hasDatabase);

suite("loading a planet to share [requires DATABASE_URL]", () => {
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

  it("finds a live planet by handle, whatever the casing", async () => {
    await live(pool, alice, "RuiBishop");

    const found = await shareSubject(pool, { handle: "ruibishop" });
    expect(found?.displayName).toBe("Rui Bishop");
  });

  it("finds it by id too", async () => {
    const id = await live(pool, alice, "ruibishop");
    expect((await shareSubject(pool, { id }))?.handle).toBe("ruibishop");
  });

  // A planet that has not been paid for has no public page, and one that lapsed
  // no longer has one.
  it("does not share a planet that is not on the board", async () => {
    await pool.query(
      `INSERT INTO blocks (user_id, x, y, size, status, reserved_until)
       VALUES ($1, 150, 150, 1, 'reserved', now() + interval '15 min')`,
      [alice],
    );
    expect(await shareSubject(pool, { handle: "ruibishop" })).toBeNull();
  });
});

function emptyStore(): AvatarStore {
  return { read: () => Promise.reject(new Error("no avatar")) };
}

async function live(pool: Pool, userId: string, handle: string): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO blocks
       (user_id, x, y, size, status, published_at, image_url, display_name, handle,
        primary_url, description, aura)
     VALUES ($1, 150, 150, 1, 'live', now(), 'https://cdn.example/a.webp', 'Rui Bishop', $2,
             'https://example.com', 'Weekly essays on typography', 'violet')
     RETURNING id`,
    [userId, handle],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error("insert returned no row");
  return row.id;
}
