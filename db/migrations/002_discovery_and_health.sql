-- 002: the things that make a planet worth renewing.
--
-- Four features, each answering a question the product could not answer before:
-- can people find me, is my link still alive, how much of the good ground is
-- left, and can I buy more of what I already have.
--
-- Clicks needed no schema: click_events has existed since the beginning and
-- nothing ever wrote to it. That is a code problem, fixed elsewhere.

-- ---------------------------------------------------------------------------
-- Categories, so a planet can be found by what its owner does
-- ---------------------------------------------------------------------------
--
-- A fixed list rather than free text. Free text becomes twelve spellings of
-- "fitness" and a filter nobody can use, and this is rendered into a public
-- page, so it is checked rather than trusted.

DO $$ BEGIN
  CREATE TYPE planet_category AS ENUM (
    'art', 'music', 'film', 'writing', 'gaming', 'tech', 'design',
    'fitness', 'food', 'travel', 'fashion', 'finance', 'comedy', 'education',
    'science', 'photography', 'podcast', 'other'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- The old column was free text. Nothing live depends on its contents yet, so
-- anything unrecognised becomes 'other' rather than blocking the migration.
ALTER TABLE blocks ADD COLUMN IF NOT EXISTS category_v2 planet_category;

UPDATE blocks
   SET category_v2 = CASE
         WHEN lower(category) = ANY (enum_range(NULL::planet_category)::text[])
           THEN lower(category)::planet_category
         WHEN category IS NOT NULL THEN 'other'::planet_category
         ELSE NULL
       END
 WHERE category_v2 IS NULL;

ALTER TABLE blocks DROP COLUMN IF EXISTS category;
ALTER TABLE blocks RENAME COLUMN category_v2 TO category;

CREATE INDEX IF NOT EXISTS blocks_category_idx
  ON blocks (category) WHERE status = 'live';

-- ---------------------------------------------------------------------------
-- Search
-- ---------------------------------------------------------------------------
--
-- A generated column rather than a trigger: it cannot drift from the row,
-- because the database computes it. 'simple' rather than 'english' so that
-- names and handles are not stemmed into something unrecognisable.

ALTER TABLE blocks ADD COLUMN IF NOT EXISTS search tsvector
  GENERATED ALWAYS AS (
    to_tsvector(
      'simple',
      coalesce(display_name, '') || ' ' ||
      coalesce(handle, '') || ' ' ||
      coalesce(description, '')
    )
  ) STORED;

CREATE INDEX IF NOT EXISTS blocks_search_idx ON blocks USING gin (search);

-- ---------------------------------------------------------------------------
-- Link health
-- ---------------------------------------------------------------------------
--
-- What killed the Million Dollar Homepage: the links died and the page became a
-- graveyard nobody could clean. Renting rather than selling solves most of it,
-- since a lapsed planet leaves. This catches the rest, where the planet is paid
-- for and the destination is gone.
--
-- Consecutive failures rather than a single one, because one timeout is not a
-- dead link, and the owner is told long before anything is taken down.

ALTER TABLE blocks ADD COLUMN IF NOT EXISTS link_ok boolean;
ALTER TABLE blocks ADD COLUMN IF NOT EXISTS link_checked_at timestamptz;
ALTER TABLE blocks ADD COLUMN IF NOT EXISTS link_failures integer NOT NULL DEFAULT 0;

ALTER TABLE blocks ADD CONSTRAINT blocks_link_failures_non_negative
  CHECK (link_failures >= 0);

-- Oldest checked first, and only what is on the board.
CREATE INDEX IF NOT EXISTS blocks_link_check_due_idx
  ON blocks (link_checked_at NULLS FIRST) WHERE status = 'live';

CREATE TABLE IF NOT EXISTS link_checks (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  block_id    uuid NOT NULL REFERENCES blocks (id) ON DELETE CASCADE,
  url         text NOT NULL,
  ok          boolean NOT NULL,
  status_code integer,
  error       text,
  checked_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS link_checks_block_idx
  ON link_checks (block_id, checked_at DESC);

-- ---------------------------------------------------------------------------
-- Growing and moving
-- ---------------------------------------------------------------------------
--
-- The strongest upsell there is: someone already owns a spot and wants more of
-- it. Both operations are ordinary claims underneath, so occupied_tiles stays
-- the only thing deciding whether a square is free, and neither can overlap
-- anything for the same reason a first purchase cannot.
--
-- This table is the record of what changed and what it changed the price to.
-- Charging the difference is the payment provider's problem; knowing the
-- difference is ours.

DO $$ BEGIN
  CREATE TYPE block_change_kind AS ENUM ('grow', 'move');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS block_changes (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  block_id            uuid NOT NULL REFERENCES blocks (id) ON DELETE CASCADE,
  kind                block_change_kind NOT NULL,

  from_x              smallint NOT NULL,
  from_y              smallint NOT NULL,
  from_size           smallint NOT NULL,
  to_x                smallint NOT NULL,
  to_y                smallint NOT NULL,
  to_size             smallint NOT NULL,

  -- Signed: moving outward is cheaper and owes the buyer, not us.
  monthly_delta_cents integer NOT NULL,
  checkout_session_id text,
  created_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT block_changes_actually_changed
    CHECK (from_x <> to_x OR from_y <> to_y OR from_size <> to_size)
);

CREATE INDEX IF NOT EXISTS block_changes_block_idx
  ON block_changes (block_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Scarcity
-- ---------------------------------------------------------------------------
--
-- "412 of 1,250 core tiles left" is the oldest lever this kind of product has,
-- and it needs the orbit of a tile in SQL to count what is taken. The radii
-- live in src/config.ts as well; src/db/schema.test.ts asserts the two agree.

CREATE OR REPLACE FUNCTION orbit_of(px numeric, py numeric)
  RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE
    WHEN point(px + 0.5, py + 0.5) <-> point(board_size() / 2.0, board_size() / 2.0) < 20
      THEN 'core'
    WHEN point(px + 0.5, py + 0.5) <-> point(board_size() / 2.0, board_size() / 2.0) < 60
      THEN 'inner'
    WHEN point(px + 0.5, py + 0.5) <-> point(board_size() / 2.0, board_size() / 2.0)
         < universe_radius()
      THEN 'outer'
    ELSE 'void'
  END
$$;
