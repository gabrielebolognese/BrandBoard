-- FlashBrand schema. Requires PostgreSQL 13+ (built-in gen_random_uuid).
--
-- The board dimension lives in exactly two places: BOARD_SIZE in src/config.ts
-- for application code, and the board_size() function below for anything the
-- database enforces on its own. src/db/schema.test.ts asserts the two agree,
-- so they cannot drift.
--
-- A block is any N x N square from 1x1 up to max_block_size() that fits inside
-- the board and does not overlap tiles someone already holds. The cap is an
-- anti-monopoly rule: 25x25 is 625 tiles, 6.25% of the board.
--
-- Changing board_size() does NOT revalidate existing CHECK constraints.
-- Resizing the board is a migration, not an edit to this file.

BEGIN;

-- ---------------------------------------------------------------------------
-- Dimensions
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION board_size() RETURNS smallint
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT 300::smallint $$;

CREATE OR REPLACE FUNCTION universe_radius() RETURNS numeric
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT 150::numeric $$;

/*
 * The universe is a disc inside that square, and a planet is inside it only
 * when its furthest corner is. Everything beyond is void: addressable, because
 * tiles are addressed by (x, y), but not for sale.
 */
CREATE OR REPLACE FUNCTION fits_in_universe(px numeric, py numeric, psize numeric)
  RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT greatest(
           point(px, py)              <-> point(board_size() / 2.0, board_size() / 2.0),
           point(px + psize, py)      <-> point(board_size() / 2.0, board_size() / 2.0),
           point(px, py + psize)      <-> point(board_size() / 2.0, board_size() / 2.0),
           point(px + psize, py + psize) <-> point(board_size() / 2.0, board_size() / 2.0)
         ) <= universe_radius()
$$;

CREATE OR REPLACE FUNCTION max_block_size() RETURNS smallint
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT 15::smallint $$;

/*
 * Size is capped per orbit, and the caps do not follow the price: core 10,
 * inner belt 15, outer reach 6. The outer reach is the cheapest ground, so
 * without a limit the rational move is an enormous cheap planet out there.
 *
 * The cap is the strictest among every orbit the square touches, not the cap
 * of whichever orbit its centre falls in. Otherwise a planet could be centred
 * just inside the inner belt and sprawl out into the outer reach at fifteen
 * wide, which is the exact thing the outer limit exists to prevent.
 */
CREATE OR REPLACE FUNCTION planet_size_cap(px numeric, py numeric, psize numeric)
  RETURNS smallint LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  WITH c AS (SELECT board_size() / 2.0 AS cx, board_size() / 2.0 AS cy),
  d AS (
    SELECT
      -- Nearest point of the square to the centre, zero when it straddles it.
      sqrt(power(greatest(px - cx, 0, cx - (px + psize)), 2)
         + power(greatest(py - cy, 0, cy - (py + psize)), 2)) AS dmin,
      greatest(
        point(px, py)                 <-> point(cx, cy),
        point(px + psize, py)         <-> point(cx, cy),
        point(px, py + psize)         <-> point(cx, cy),
        point(px + psize, py + psize) <-> point(cx, cy)
      ) AS dmax
    FROM c
  )
  SELECT least(
    CASE WHEN dmin < 20                 THEN 10 ELSE 999 END,
    CASE WHEN dmax > 20 AND dmin < 60   THEN 15 ELSE 999 END,
    CASE WHEN dmax > 60                 THEN  6 ELSE 999 END
  )::smallint FROM d
$$;

-- ---------------------------------------------------------------------------
-- users
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  x_handle      text,
  x_user_id     text UNIQUE,
  email         text,
  avatar_url    text,
  is_admin      boolean NOT NULL DEFAULT false,

  -- One free trial per account, ever. Without this the trial is just a way to
  -- hold tiles forever for nothing.
  trial_used_at timestamptz,

  created_at    timestamptz NOT NULL DEFAULT now(),

  -- X OAuth is primary, magic link is the fallback; one of them must identify
  -- the row or there is no way to sign back in.
  CONSTRAINT users_has_identity CHECK (x_user_id IS NOT NULL OR email IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_key
  ON users (lower(email)) WHERE email IS NOT NULL;

-- ---------------------------------------------------------------------------
-- blocks
-- ---------------------------------------------------------------------------

DO $$ BEGIN
  CREATE TYPE block_status AS ENUM
    ('reserved', 'pending_review', 'live', 'expired', 'rejected');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS blocks (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,

  x                   smallint NOT NULL,   -- top-left tile, 0..board_size()-1
  y                   smallint NOT NULL,
  size                smallint NOT NULL,   -- 1..max_block_size()

  status              block_status NOT NULL DEFAULT 'reserved',
  reserved_until      timestamptz,
  checkout_session_id text,                -- not unique: one cart checkout can cover several blocks

  image_url           text,                -- square, cropped, WebP
  display_name        text,
  handle              text,
  primary_url         text,                -- where the click goes
  description         text,
  links               jsonb NOT NULL DEFAULT '{}'::jsonb,
  category            text,

  -- The colour of the halo this planet sits in. One of a fixed set, checked
  -- here rather than trusted, because it is rendered into a public page.
  aura                text NOT NULL DEFAULT 'azure',

  -- Set when a planet goes live without payment. Once it passes, the planet is
  -- released by the same sweep that handles a lapsed subscription.
  trial_ends_at       timestamptz,

  -- Blocks are rented monthly, so a live block has a subscription behind it and
  -- a period it is paid through. Both stay null until the payment provider says
  -- otherwise; wiring them up is Paddle's job.
  --
  -- Deliberately not unique: one cart is one subscription covering every block
  -- in it, so several blocks share a subscription_id.
  subscription_id     text,
  current_period_end  timestamptz,

  click_count         integer NOT NULL DEFAULT 0,
  created_at          timestamptz NOT NULL DEFAULT now(),
  published_at        timestamptz,

  -- Capped so no single buyer can corner the board. Overlap is still refused
  -- by occupied_tiles rather than here.
  CONSTRAINT blocks_size_range
    CHECK (size BETWEEN 1 AND max_block_size()),

  -- A block is defined by its top-left tile, so the whole square must fit.
  -- This is what rejects (98, 98) at size 3.
  CONSTRAINT blocks_within_board
    CHECK (x >= 0 AND y >= 0
           AND x + size <= board_size()
           AND y + size <= board_size()),

  -- And inside the disc, not merely inside the square that contains it.
  CONSTRAINT blocks_within_universe
    CHECK (fits_in_universe(x::numeric, y::numeric, size::numeric)),

  -- And no larger than the orbits it touches allow.
  CONSTRAINT blocks_size_fits_orbit
    CHECK (size <= planet_size_cap(x::numeric, y::numeric, size::numeric)),

  -- reserved_until is meaningful only while reserved, and is cleared on payment.
  CONSTRAINT blocks_reservation_window CHECK (
    CASE status
      WHEN 'reserved'       THEN reserved_until IS NOT NULL
      WHEN 'pending_review' THEN reserved_until IS NULL
      WHEN 'live'           THEN reserved_until IS NULL
      ELSE true   -- expired / rejected keep the timestamp as a record
    END
  ),

  -- Nothing reaches the public board without the content the board renders.
  CONSTRAINT blocks_live_requires_content CHECK (
    status <> 'live' OR (
      image_url    IS NOT NULL AND
      display_name IS NOT NULL AND
      handle       IS NOT NULL AND
      primary_url  IS NOT NULL
    )
  ),

  CONSTRAINT blocks_published_only_when_live
    CHECK (published_at IS NULL OR status = 'live'),

  CONSTRAINT blocks_click_count_non_negative
    CHECK (click_count >= 0),

  CONSTRAINT blocks_aura_known
    CHECK (aura IN ('violet', 'azure', 'cyan', 'emerald', 'amber', 'rose', 'pearl')),

  CONSTRAINT blocks_description_length
    CHECK (description IS NULL OR length(description) <= 280)
);

CREATE INDEX IF NOT EXISTS blocks_user_id_idx ON blocks (user_id);

-- Drives the review queue and the live manifest.
CREATE INDEX IF NOT EXISTS blocks_status_idx ON blocks (status);

-- Drives lazy cleanup and the every-minute sweep. Partial, because reserved is
-- a small and short-lived slice of the table.
CREATE INDEX IF NOT EXISTS blocks_reserved_expiry_idx
  ON blocks (reserved_until) WHERE status = 'reserved';

-- /b/[handle] has to resolve to one creator.
CREATE UNIQUE INDEX IF NOT EXISTS blocks_handle_lower_key
  ON blocks (lower(handle))
  WHERE handle IS NOT NULL AND status IN ('pending_review', 'live');

-- ---------------------------------------------------------------------------
-- occupied_tiles  -- the collision mechanism
-- ---------------------------------------------------------------------------
--
-- One row per occupied tile. The primary key on (x, y) is what makes
-- double-booking impossible: overlap is a duplicate key, enforced by the
-- storage layer, not by application logic that could be raced or skipped.
-- Held from reservation through review, released only on expiry or rejection.

CREATE TABLE IF NOT EXISTS occupied_tiles (
  x        smallint NOT NULL,
  y        smallint NOT NULL,
  block_id uuid NOT NULL REFERENCES blocks (id) ON DELETE CASCADE,

  PRIMARY KEY (x, y),

  CONSTRAINT occupied_tiles_within_board
    CHECK (x >= 0 AND x < board_size() AND y >= 0 AND y < board_size())
);

-- The FK gives no index of its own; cleanup deletes by block_id.
CREATE INDEX IF NOT EXISTS occupied_tiles_block_id_idx ON occupied_tiles (block_id);

-- ---------------------------------------------------------------------------
-- featured_slots
-- ---------------------------------------------------------------------------
--
-- A block can be featured for a stretch of days, bought separately from the
-- tile rent. Each purchase carries its own window: starts_at is when it was
-- bought and expires_at is that plus the days paid for. There is no shared
-- daily reset, so two slots bought five hours apart expire five hours apart.
--
-- A block may be featured more than once over its life, so this is a table of
-- purchases rather than a column on blocks. Overlapping windows for one block
-- are allowed and simply extend the time it appears.

CREATE TABLE IF NOT EXISTS featured_slots (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  block_id            uuid NOT NULL REFERENCES blocks (id) ON DELETE CASCADE,

  days                smallint NOT NULL,
  price_cents         integer NOT NULL,
  checkout_session_id text,

  starts_at           timestamptz NOT NULL DEFAULT now(),
  expires_at          timestamptz NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT featured_days_range CHECK (days BETWEEN 1 AND 10),
  CONSTRAINT featured_price_positive CHECK (price_cents > 0),
  CONSTRAINT featured_window_forward CHECK (expires_at > starts_at)
);

-- Drives the "what is featured right now" read, which filters on expires_at.
CREATE INDEX IF NOT EXISTS featured_slots_active_idx
  ON featured_slots (expires_at DESC);

CREATE INDEX IF NOT EXISTS featured_slots_block_idx ON featured_slots (block_id);

-- ---------------------------------------------------------------------------
-- click_events
-- ---------------------------------------------------------------------------
--
-- ip_hash is a salted SHA-256 of the client IP, never the IP itself. The unique
-- key deduplicates to one counted click per block per visitor per day.

CREATE TABLE IF NOT EXISTS click_events (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  block_id   uuid NOT NULL REFERENCES blocks (id) ON DELETE CASCADE,
  day        date NOT NULL DEFAULT current_date,
  ip_hash    bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT click_events_unique_per_day UNIQUE (block_id, day, ip_hash)
);

CREATE INDEX IF NOT EXISTS click_events_block_day_idx ON click_events (block_id, day);

-- ---------------------------------------------------------------------------
-- webhook_events
-- ---------------------------------------------------------------------------
--
-- Payment providers retry. The same event will arrive twice, and publishing a
-- block twice or refunding twice because of it is not acceptable.
--
-- The unique key on (provider, event_id) is what prevents that, in the same way
-- occupied_tiles prevents double booking: the second delivery is a duplicate
-- key, refused by storage, whatever the application does. Handlers insert here
-- first and do nothing if the insert finds a row already there.

CREATE TABLE IF NOT EXISTS webhook_events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider     text NOT NULL,
  event_id     text NOT NULL,       -- the provider's id for this delivery
  event_type   text NOT NULL,
  payload      jsonb NOT NULL,
  received_at  timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  outcome      text,                -- what the handler decided, for support

  CONSTRAINT webhook_events_unique_delivery UNIQUE (provider, event_id)
);

CREATE INDEX IF NOT EXISTS webhook_events_recent_idx
  ON webhook_events (provider, event_type, received_at DESC);

-- ---------------------------------------------------------------------------
-- refunds_owed
-- ---------------------------------------------------------------------------
--
-- Money we have taken and must give back, recorded before anyone tries to give
-- it back. Issuing a refund is a call to a payment provider that can fail; if
-- the obligation only existed in that call, a failure would lose it silently.
--
-- Three things create one: tiles sold out from under a payment that was already
-- in flight, a listing rejected in review, and a subscription that lapsed with
-- time already paid for.

DO $$ BEGIN
  CREATE TYPE refund_reason AS ENUM ('tiles_lost', 'rejected_in_review', 'subscription_lapsed');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS refunds_owed (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  block_id            uuid NOT NULL REFERENCES blocks (id) ON DELETE CASCADE,
  checkout_session_id text,
  reason              refund_reason NOT NULL,
  amount_cents        integer NOT NULL,

  created_at          timestamptz NOT NULL DEFAULT now(),
  settled_at          timestamptz,
  provider_ref        text,          -- the provider's refund or adjustment id

  CONSTRAINT refunds_amount_positive CHECK (amount_cents > 0),

  -- A refund is only settled once a provider has confirmed it with an id.
  CONSTRAINT refunds_settled_has_reference
    CHECK (settled_at IS NULL OR provider_ref IS NOT NULL),

  -- One obligation per block per cause, so a replayed event cannot owe twice.
  CONSTRAINT refunds_one_per_block_reason UNIQUE (block_id, reason)
);

-- Outstanding work only: the settled rows are history and are never scanned.
CREATE INDEX IF NOT EXISTS refunds_owed_outstanding_idx
  ON refunds_owed (created_at) WHERE settled_at IS NULL;

-- ---------------------------------------------------------------------------
-- Migrations for databases created before a change
-- ---------------------------------------------------------------------------
--
-- CREATE TABLE IF NOT EXISTS leaves an existing table untouched, so anything
-- that changes an existing constraint has to say so explicitly.

-- Block sizes: once capped at 5x5, then briefly uncapped, now capped at
-- max_block_size(). Adding the constraint fails loudly if any existing block is
-- already larger than the cap, which is the correct outcome: that is data the
-- new rule forbids and it needs a decision, not a silent pass.
ALTER TABLE blocks DROP CONSTRAINT IF EXISTS blocks_size_positive;

DO $$ BEGIN
  ALTER TABLE blocks ADD CONSTRAINT blocks_size_range
    CHECK (size BETWEEN 1 AND max_block_size());
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- The board became a disc of orbits, three hundred tiles across.
DO $$ BEGIN
  ALTER TABLE blocks ADD CONSTRAINT blocks_within_universe
    CHECK (fits_in_universe(x::numeric, y::numeric, size::numeric));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Per-orbit size caps arrived after the universe did. Adding this fails loudly
-- if any existing planet is larger than its orbit now allows, which is correct:
-- that is data the new rule forbids and it needs a decision, not a silent pass.
DO $$ BEGIN
  ALTER TABLE blocks ADD CONSTRAINT blocks_size_fits_orbit
    CHECK (size <= planet_size_cap(x::numeric, y::numeric, size::numeric));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Listing detail, aura and trials arrived after the first schema.
ALTER TABLE blocks ADD COLUMN IF NOT EXISTS description text;
ALTER TABLE blocks ADD COLUMN IF NOT EXISTS aura text NOT NULL DEFAULT 'azure';
ALTER TABLE blocks ADD COLUMN IF NOT EXISTS trial_ends_at timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS trial_used_at timestamptz;

DO $$ BEGIN
  ALTER TABLE blocks ADD CONSTRAINT blocks_aura_known
    CHECK (aura IN ('violet', 'azure', 'cyan', 'emerald', 'amber', 'rose', 'pearl'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE blocks ADD CONSTRAINT blocks_description_length
    CHECK (description IS NULL OR length(description) <= 280);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Drives the trial sweep.
CREATE INDEX IF NOT EXISTS blocks_trial_end_idx
  ON blocks (trial_ends_at) WHERE trial_ends_at IS NOT NULL;

-- Monthly billing arrived after the first schema.
ALTER TABLE blocks ADD COLUMN IF NOT EXISTS subscription_id text;
ALTER TABLE blocks ADD COLUMN IF NOT EXISTS current_period_end timestamptz;

-- subscription_id was briefly unique, which is wrong: a cart checks out as one
-- subscription covering every block in it, so they share the id.
ALTER TABLE blocks DROP CONSTRAINT IF EXISTS blocks_subscription_id_key;

CREATE INDEX IF NOT EXISTS blocks_subscription_idx
  ON blocks (subscription_id) WHERE subscription_id IS NOT NULL;

-- Drives the lapse sweep: live blocks whose paid period has ended.
CREATE INDEX IF NOT EXISTS blocks_period_end_idx
  ON blocks (current_period_end) WHERE status = 'live';

COMMIT;
