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
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT 100::smallint $$;

CREATE OR REPLACE FUNCTION max_block_size() RETURNS smallint
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT 25::smallint $$;

-- ---------------------------------------------------------------------------
-- users
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS users (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  x_handle    text,
  x_user_id   text UNIQUE,
  email       text,
  avatar_url  text,
  is_admin    boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),

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
  links               jsonb NOT NULL DEFAULT '{}'::jsonb,
  category            text,

  -- Blocks are rented monthly, so a live block has a subscription behind it and
  -- a period it is paid through. Both stay null until the payment provider says
  -- otherwise; wiring them up is Paddle's job.
  subscription_id     text UNIQUE,
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
    CHECK (click_count >= 0)
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

-- Monthly billing arrived after the first schema.
ALTER TABLE blocks ADD COLUMN IF NOT EXISTS subscription_id text;
ALTER TABLE blocks ADD COLUMN IF NOT EXISTS current_period_end timestamptz;

DO $$ BEGIN
  ALTER TABLE blocks ADD CONSTRAINT blocks_subscription_id_key UNIQUE (subscription_id);
EXCEPTION WHEN duplicate_table THEN NULL; WHEN duplicate_object THEN NULL;
END $$;

COMMIT;
