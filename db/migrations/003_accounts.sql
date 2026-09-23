-- 003: accounts.
--
-- Everything until now has run as one hardcoded user, which was fine while the
-- only question was whether the board worked. It stops being fine the moment
-- money is involved: a Polar checkout needs a customer to attach to, a dead
-- link needs somebody to tell, and "only touch your own planets" needs a notion
-- of yours.
--
-- Two ways in, per the launch plan: X OAuth as the primary, and an emailed
-- single-use link as the fallback. The users table already allowed for both;
-- this adds what is needed to actually sign someone in and keep them signed in.

-- ---------------------------------------------------------------------------
-- Identity
-- ---------------------------------------------------------------------------
--
-- users_has_identity already insists on an x_user_id or an email. What was
-- missing is that the email has to be unique, or two sign-ins with the same
-- address make two accounts and the second one cannot see the first one's
-- planets.
--
-- On lower(email), because nobody believes their address is case sensitive.
-- Partial, because a row identified by X alone has no email at all and several
-- such rows must not collide on NULL.

CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_key
  ON users (lower(email)) WHERE email IS NOT NULL;

-- Sign-in has to be able to say when, and support has to be able to answer
-- "when did I last get in".
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen_at timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name text;

-- ---------------------------------------------------------------------------
-- Sessions
-- ---------------------------------------------------------------------------
--
-- The cookie carries a random token; this table stores only its SHA-256. A
-- database that leaks its rows therefore leaks nothing that can be presented as
-- a session, which is the same reasoning that applies to any other credential.
--
-- ON DELETE CASCADE: deleting a user must not leave a way to authenticate as
-- them.

CREATE TABLE IF NOT EXISTS sessions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,

  -- SHA-256 of the token in the cookie. Never the token itself.
  token_hash   bytea NOT NULL UNIQUE,

  -- An absolute end, not a sliding one that can be extended forever by a
  -- stolen cookie being used.
  expires_at   timestamptz NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz NOT NULL DEFAULT now(),

  -- Enough to recognise a session in a list and no more. Deliberately not the
  -- IP address: it would be one more personal identifier to defend, for the
  -- sake of a feature nobody has asked for.
  user_agent   text,

  CONSTRAINT sessions_expire_after_creation CHECK (expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id, last_used_at DESC);

-- The sweep that clears expired rows reads this.
CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions (expires_at);

-- ---------------------------------------------------------------------------
-- Sign-in links
-- ---------------------------------------------------------------------------
--
-- Same rule as sessions: the token goes in the email, its hash goes here.
-- Single use is enforced by consumed_at rather than by deleting the row, so a
-- link that is clicked twice can be told apart from one that never existed,
-- which is the difference between "you already used this" and a blank page.
--
-- requested_ip_hash is for rate limiting only, and is hashed for the same
-- reason a click is: it answers "is this the same source" without being a
-- record of where somebody was.

CREATE TABLE IF NOT EXISTS login_tokens (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email             text NOT NULL,
  token_hash        bytea NOT NULL UNIQUE,
  expires_at        timestamptz NOT NULL,
  consumed_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  requested_ip_hash bytea,

  CONSTRAINT login_tokens_expire_after_creation CHECK (expires_at > created_at)
);

-- Rate limiting counts recent rows for an address, so it reads this way round.
CREATE INDEX IF NOT EXISTS login_tokens_email_idx
  ON login_tokens (lower(email), created_at DESC);

CREATE INDEX IF NOT EXISTS login_tokens_expiry_idx ON login_tokens (expires_at);

-- ---------------------------------------------------------------------------
-- Ownership
-- ---------------------------------------------------------------------------
--
-- blocks.user_id has always been there and has always been RESTRICT on delete,
-- which is right: a planet on the board is not something a user deletion should
-- quietly take with it. This only adds the index, because every dashboard query
-- from here on is "my planets".

CREATE INDEX IF NOT EXISTS blocks_user_idx ON blocks (user_id, created_at DESC);
