# BrandSpace — launch plan

A public directory of personal brands laid out as a universe. Creators buy a
planet in one of three orbits, put their face on it, and link out to wherever
their audience already is. Visitors explore the universe and click through.

This document is the path from what exists today to something real people can
pay for. It is meant to be edited as work happens: tick things off, and when a
decision gets made, write it down here rather than only in a commit.

---

## 1. Where the code actually is

Being honest about this matters, because a plan that assumes more than exists
will schedule the wrong things.

### Built and tested (97 tests)

| Area | State |
|---|---|
| Schema | `users`, `blocks`, `occupied_tiles`, `featured_slots`, `click_events`, `webhook_events`, `refunds_owed` |
| Collision | `occupied_tiles` with `PRIMARY KEY (x, y)`. Overlap is a duplicate key, refused by storage |
| Claiming | One atomic transaction. Cart is all-or-nothing. Conflicts return 409 with the offending tiles |
| Reservations | 15 minute hold, released lazily on every claim and by a sweep every minute |
| Orbits | 300×300 disc, radius 150. Core `<20` $5, inner belt `<60` $3, outer reach `<150` $1, per tile per month |
| Pricing | Summed per tile from the orbits, capped in size per orbit. Never accepted from the client |
| Checkout | Cart → reserve → listing → server-priced order, billed yearly with a $5/month floor. `/pay` answers 503 until Polar is wired |
| Payment plumbing | Webhook idempotency, signature verification over raw bytes, fulfilment with refunds for tiles lost mid-payment, subscription lapse both by webhook and by sweep, `refunds_owed` queue |
| Review | `approveBlock` / `rejectBlock` exist as functions, with refund on rejection |
| Featured | Per-purchase windows, 1–10 days, $10 first day then $8. Each runs its own clock |
| Rendering | Transparent planet sheet, per-planet detail sprites by zoom tier, starfield, nebulae, orbit auras, halos |

### Not built at all

- **Accounts.** No auth of any kind. Every action runs as one hardcoded dev user.
- **Anything to post.** No upload, no image storage, no listing setup screen.
- **A web framework.** `src/dev-server.ts` is a `node:http` harness with a
  `/api/reset` that truncates the board. It is not a product server.
- **Admin.** `approveBlock` and `rejectBlock` have no interface.
- **Dashboard.** No "my planets" screen.
- **Listing pages.** No `/b/[handle]`, which is the entire SEO surface.
- **Clicks.** `click_events` exists and **nothing ever writes to it**.
  `click_count` is never incremented. The stats row reports a number that is
  structurally always zero.
- **Rate limiting, CI, monitoring, legal pages, moderation tooling.**

---

## 2. Decisions that block work

These are not implementation details. Each one changes what gets built, and
guessing wrong means rework.

### D1 — Web framework  ▸ *recommend Next.js App Router*

Needed before any UI work. `/b/[handle]` has to be server rendered with real
metadata or the SEO surface is worthless, and that is the thing a framework is
for. Next.js is the recommendation because the SSR story is the best fit, and
because there is already a Next.js app on this machine, so it is known ground.

Everything under `src/board/` and `src/payments/` is framework-agnostic and
moves across unchanged. Only `src/dev-server.ts` and `public/` get rewritten.

### D2 — Hosting and infrastructure  ▸ *recommend Vercel + Neon + Cloudflare R2*

Payments are settled: Polar, yearly, $5 a month floor.

- **Vercel** for the app, since it follows from D1.
- **Neon** for Postgres: branching makes the test database story trivial, and
  the schema is plain SQL with no ORM to fight.
- **Cloudflare R2** for avatars and the planet sheet. No egress fees, which
  matters when the sheet and sprites are the bulk of the bytes served.

**Important:** the composite sheet is a 3600×3600 render with sharp. Doing that
inside a request is wrong. It belongs in a background job that writes the sheet
to R2 and serves it from CDN. See P6.

### D3 — Does a lapsed subscription lose the planet?

`lapseSubscription` frees the tiles today. That is one policy, not the only one.
The alternatives are: the planet goes dark but keeps its square for N days, or
it stays live and the account goes into dunning. **Recommend:** dark for the
3 day grace, then tiles released. Whatever is chosen goes in the ToS.

### D4 — Featured contention

More than five active windows shows the newest five. Nobody's purchase can fail
for lack of a slot, but nobody is guaranteed to be seen either. **Recommend:**
sell a fixed number of concurrent slots so the product is honest, using the same
storage-layer approach as tiles. Deferrable to after launch if volume is low.

### D5 — Outbound link `rel`

`nofollow` protects against being an SEO farm. Not using it is worth more to
creators, and is a selling point. **Recommend:** `rel="ugc noopener"` — honest
about what it is without being worthless to the buyer.

### D6 — Cold start

The universe launches empty. An empty universe looks dead and sells nothing.
**Recommend:** hand-place 30–60 real founding creators at a heavy discount or
free, in the inner belt, before opening. This is a real task, not an afterthought.

### D7 — Rename `blocks` to `planets` in the schema?

The UI says planet, the data model says block. **Recommend:** leave it. A
rename touches every file for zero functional gain, and the mismatch is
documented. Revisit only if it confuses a second engineer.

---

## 3. Phases

Each phase is shippable and leaves the product working. Do not start a phase
whose blocking decision is still open.

### P0 — Rename to BrandSpace  *(half a day)*

The product is called FlashBrand throughout, and the repo is BrandBoard.

- [ ] `package.json` name, `README.md`, `CLAUDE.md`
- [ ] UI copy and `<title>` in `public/index.html`
- [ ] Log lines in `src/dev-server.ts`
- [ ] Rename the GitHub repo, update the remote
- [ ] Register the domain and lock down the handle on X, Instagram, YouTube

**Acceptance:** `grep -ri flashbrand` and `grep -ri brandboard` return nothing.

### P1 — Framework skeleton  *(2–3 days)* — blocked by D1, D2

- [ ] Scaffold the app; move `src/board/` and `src/payments/` across untouched
- [ ] Port `public/*.js` to a client component; the canvas code is portable
- [ ] Real config: `DATABASE_URL`, storage keys, secrets, per environment
- [ ] Delete `/api/reset` and the hardcoded dev user; keep `src/dev-server.ts`
      only if it is worth maintaining as a local harness
- [ ] Deploy a blank build to a real URL behind a password

**Acceptance:** the universe renders on a public URL from a real Postgres,
tests still pass against a Neon branch.

### P2 — Accounts  *(3–4 days)*

This is the first half of "people need an account and then something to post".

- [ ] X OAuth 2.0 with PKCE. On callback, upsert `users` by `x_user_id`,
      capture `x_handle` and `avatar_url`
- [ ] Email magic link fallback: signed single-use token, 15 minute expiry,
      rate limited per address
- [ ] Sessions: httpOnly, secure, sameSite=lax cookies. Rotate on sign-in
- [ ] `is_admin` gate for the review queue
- [ ] Replace every `devUserId` with the session user
- [ ] Ownership checks on every mutation. A user may only touch their own
      planets, and the pay endpoint must verify the order belongs to them

**Acceptance:** two browsers, two accounts, neither can see or modify the
other's reservations. Signing out invalidates the session.

**Security notes:** `users_has_identity` already requires `x_user_id` or
`email`. Magic link tokens must be single-use and stored hashed. Email is a
personal identifier and is already covered by the privacy work in P7.

### P3 — Something to post  *(4–5 days)* — blocked by D2

The second half. Reached after payment, at `/claim/[blockId]`.

- [ ] Avatar upload: square crop client-side, max 2MB in, WebP out
- [ ] **Server-side validation is not optional.** Re-decode every upload with
      sharp, cap dimensions and decoded pixel count, strip metadata, re-encode.
      Never trust a content type. An image bomb or a polyglot file reaching the
      compositor is the most likely way this service gets taken down
- [ ] Store in R2 under a key derived from the block id; `image_url` points there
- [ ] Form: display name, handle, primary URL, platform links, category
- [ ] Handle validation against `blocks_handle_lower_key`, with a clear error
      rather than a constraint violation
- [ ] URL validation: require https, reject javascript: and data:
- [ ] Submitting moves the planet to `pending_review`
- [ ] `avatarPixelsFor` becomes irrelevant for real uploads; keep it for seeds

**Acceptance:** a real account can pay, fill in a listing, and see it queued.
A 40MB PNG, a 30000×30000 image, and a file claiming to be a PNG but is not are
all rejected with a readable message.

### P4 — Payments  *(2–3 days)* — decided: Polar, billed yearly

**Decided.** Polar as merchant of record, so VAT and sales tax worldwide are
theirs rather than yours. Billed a year at a time with a $5 a month floor,
because card processing on a one dollar monthly subscription costs a third of
it: a year in one transaction turns that into a few percent, and the floor
stops the smallest planets being sold at a loss. Both are built.

Already done: Standard Webhooks signature verification, delivery idempotency
keyed on `webhook-id`, order fulfilment, refunds, the lapse sweep, and the
annual totals with the floor. The seam left is `payCheckout`.

- [ ] Confirm with Polar that this product category is accepted
- [ ] Catalog: three recurring yearly prices, one per orbit, quantity = tiles in
      that orbit; two one-time prices for featured, day one and extra days
- [ ] Create a Polar checkout with `metadata: { checkoutId }` and return its URL
- [ ] Point a webhook at `/api/webhooks/polar`, set `POLAR_WEBHOOK_SECRET`
- [ ] Verify the event names against the dashboard. Anything unrecognised is
      recorded and ignored, so a rename fails quietly — watch `unprocessedEvents()`
- [ ] Drain `outstandingRefunds()` into Polar refunds on a schedule
- [ ] Flip `ready: true`

**Acceptance:** a sandbox payment moves a planet to `pending_review`, a replayed
delivery changes nothing, and a payment landing after the hold lapsed produces a
refund rather than a delivery.

### P5 — Review queue  *(2 days)* — blocked by P2

Nothing user-uploaded reaches a public board without a human looking at it.

- [ ] `/admin` behind `is_admin`: queue of `pending_review` with the image,
      the destination URL, and the account
- [ ] Approve and reject buttons calling the existing functions
- [ ] Rejection reasons, and an email to the creator
- [ ] Board occupancy and revenue, kept minimal

**Acceptance:** approving publishes and the sheet regenerates; rejecting frees
the tiles and books the refund.

### P6 — The sheet as a background job  *(2 days)* — blocked by D2

Regenerating a 3600×3600 composite inside a request will not survive contact
with traffic.

- [ ] On publish, enqueue a regeneration rather than rendering inline
- [ ] Worker renders, writes to R2, updates the version
- [ ] Serve the sheet and sprites from CDN with the version as a cache key
- [ ] Keep the in-process single-flight as a local fallback

**Acceptance:** ten simultaneous publishes cause one render.

### P7 — Dashboard, listing pages, clicks  *(3–4 days)* — blocked by P2

- [ ] `/dashboard`: owned planets, status badges, click counts, edit
- [ ] Edits to image or URL re-enter review; edits to display name do not
- [ ] `/b/[handle]`: server rendered, real title, description, canonical,
      OpenGraph. This is the SEO surface
- [ ] **Click recording, which does not exist at all today.** `POST /api/click`
      writes `click_events` with a salted SHA-256 of the IP, deduplicated by the
      unique key, and increments `click_count`. Fire it on planet click and on
      the listing page
- [ ] Apply the D5 decision to outbound links

**Acceptance:** clicking a planet records exactly one event per visitor per day
and the dashboard number moves.

### P8 — Trust, safety, legal  *(3–4 days, start early)*

A public board of user-uploaded images pointing at arbitrary URLs.

- [ ] Terms of service, privacy policy, content policy, refund policy
- [ ] The D3 lapse policy written into the terms
- [ ] Report button on every planet, and a queue for reports
- [ ] Takedown path: what happens to the tiles and the money when a live planet
      has to come down. Reuse `rejectBlock` and `refunds_owed`
- [ ] GDPR: the IP hash is already a hash; document the salt, retention, and
      the deletion path for an account
- [ ] Cookie banner only if analytics are added; the session cookie alone is
      strictly necessary and does not need one
- [ ] Company details and VAT handled by Paddle as merchant of record

### P9 — Operations  *(2–3 days)*

- [ ] CI: GitHub Actions with a Postgres service, `npm run typecheck` and
      `npm test` with `DATABASE_URL` set. The database suites skip silently
      without it, so CI must set it or it proves nothing
- [ ] Cron: reservation sweep every minute, subscription sweep every 10 minutes,
      refund drain. Today these are `setInterval` in a process that may not exist
- [ ] Error tracking and uptime monitoring
- [ ] Rate limiting on claim, checkout, upload, magic link
- [ ] Security headers: CSP, HSTS. `nosniff` is already set
- [ ] Backups and a tested restore
- [ ] Runbook: what to do when the sheet is stale, a webhook is stuck, or a
      refund fails

### P10 — Launch  *(1 week)*

- [ ] Founding creators placed (D6)
- [ ] Pricing sanity check against what a 1×1 in the core actually costs a year
- [ ] Landing copy explaining orbits and pricing in one screen
- [ ] Waitlist, then invite in batches so review stays manageable
- [ ] Announce

---

## 4. Rough order and effort

```
P0  rename                half a day
P1  framework             2-3 days    ← D1, D2
P2  accounts              3-4 days
P3  listing pipeline      4-5 days    ← D2
P4  payments              2-3 days
P5  review queue          2 days
P6  sheet as a job        2 days
P7  dashboard, pages, clicks  3-4 days
P8  trust and legal       3-4 days    (start during P2)
P9  operations            2-3 days
P10 launch                1 week
```

Roughly five to six weeks of focused work. P8 should run alongside earlier
phases rather than waiting, because the policies it settles are referenced by
P3 and P5.

---

## 5. Risks

**Polar may not accept the category.** Ask before finishing P4. If refused,
Lemon Squeezy is the nearest equivalent; Stripe works but makes you merchant of
record and liable for sales tax worldwide, which is a materially different
business. The plumbing is provider-agnostic apart from `payCheckout` and the
signature scheme, so switching is a day rather than a migration.

**The universe is very large.** ~70,000 sellable tiles, ~59,000 of them at $1.
Scarcity is what makes boards like this work. If the outer reach looks empty
rather than vast, pull the radius in — it is one constant and a migration.

**Review is a human bottleneck.** Every listing needs a person. Batch invites so
the queue does not outrun whoever is reading it.

**The sheet grows with success.** Every publish regenerates it. P6 exists for
this, and should not slip.

**Nothing records clicks today.** "Clicks delivered" is the number creators will
judge value by, and it is currently structurally zero. P7 is not optional.

---

## 6. Deliberately not doing

From the original scope, still out: auctions or dynamic pricing, a secondary
market, animated planets, follower verification, comments, search, a mobile app,
and any analytics beyond the click counter.

Added since and also out: a public API, teams or multi-user accounts, and
anything that lets a buyer change orbit after purchase.
