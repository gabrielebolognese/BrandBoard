# FlashBrand

A public directory of personal brands laid out as a purchasable pixel grid.
Creators buy square blocks on a shared 100x100 board, drop in an avatar, and
link out to X, Instagram, YouTube, TikTok, Twitch, or a newsletter. Visitors
browse the board and click through.

Homepage real estate, except the inventory is creator identity rather than
company logos.

## Run it

```bash
npm install
npm run dev
```

`npm run dev` boots a throwaway PostgreSQL, applies the schema, seeds a few
hundred fake listings, renders the board image, and serves the whole thing. No
Docker and no system PostgreSQL required. It prints the URL it picked, starting
at <http://localhost:4310> and walking up if the port is busy.

| Command | What it does |
| --- | --- |
| `npm run dev` | Throwaway PostgreSQL plus the board server |
| `npm run serve` | The server against an existing `DATABASE_URL` |
| `npm test` | vitest once; database suites skip without `DATABASE_URL` |
| `npm run test:db` | Throwaway PostgreSQL, then the whole suite against it |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run db:up` / `db:down` | Local PostgreSQL via docker compose, port 5433 |
| `npm run db:setup` | Apply `db/schema.sql` to `DATABASE_URL` |

## How the board works

**Blocks.** A block is an N x N square of tiles anchored at its top-left tile.
There is no maximum size and no alignment grid: a block may sit at any (x, y)
and be any size that fits on the board. The only rule is that it cannot overlap
tiles someone already holds.

**Collisions.** `occupied_tiles` holds one row per occupied tile with
`PRIMARY KEY (x, y)`. Overlap is therefore a duplicate key, refused by the
storage layer rather than by application logic that could be raced. A claim is
one transaction: sweep lapsed reservations, insert the blocks, insert their
tiles. A duplicate key means someone won the square first, so the claim rolls
back and returns 409 with the conflicting coordinates. It never retries and
never relocates the block.

**Reservations.** A claim holds its tiles for 15 minutes. Lapsed reservations
are released both lazily, on every claim, and by a sweep that runs every minute,
so an idle board does not sit holding tiles nobody paid for. Both paths are
idempotent.

**Review.** Payment moves a block to `pending_review`, not `live`. Tiles stay
held throughout. An admin approves or rejects; rejection refunds and frees the
tiles.

**Rendering.** Ten thousand tiles are not ten thousand DOM nodes. The board is
one composite WebP regenerated whenever a block goes live, plus a compact JSON
manifest of live blocks for hit testing. Pan, zoom, and hover are arithmetic
against (x, y, size), with no per-block event listeners.

## Layout

```
db/schema.sql        schema, constraints, and the collision table
src/config.ts        board dimensions and tile geometry, the single source
src/board/claim.ts   the claim transaction
src/board/cleanup.ts reservation expiry, lazy and scheduled
src/board/composite.ts  the composite board image
src/board/manifest.ts   manifest and availability bitmap
src/dev-server.ts    development harness serving the board
public/              the board client
```

## Status

Schema, the claim transaction, and board rendering are built and tested.
Checkout, the review queue, dashboards, and listing pages are not.

The database-backed tests need a real PostgreSQL and skip loudly when
`DATABASE_URL` is unset. There is no mock, because a mock that accepted two
overlapping writers would pass while the product was broken.
