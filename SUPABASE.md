# Supabase

## The thing to decide first

Supabase is two products that happen to share a dashboard, and only one of them
is what "we need an account database" needs.

**Postgres.** A hosted database. This codebase is a plain Postgres application:
numbered migrations, `pg` as the driver, SQL written by hand. Supabase Postgres
is a drop-in. Nothing in `src/` changes, and `db/migrations/*.sql` runs against
it unaltered.

**Supabase Auth (GoTrue).** A whole authentication system, with its own
`auth.users` table, its own JWTs and its own session model. We already have one:
`src/auth/sessions.ts` and `src/auth/magiclink.ts`, 39 tests, emailed sign-in
links, hashed tokens, revocable sessions.

**Take the database. Leave the auth, for now.** Adopting GoTrue means deleting
working, tested code and rewriting every ownership check around a JWT, in
exchange for nothing you do not already have. The one thing it would buy is
social sign-in without implementing OAuth yourself, and if you want that later
there is a way to take only that piece. See the last section.

---

## Part 1: the database

### 1. Make the project

New project at [supabase.com/dashboard](https://supabase.com/dashboard). Two
choices that are annoying to change later:

- **Region.** Put it near your users, not near you. Every board render is a
  round trip.
- **Database password.** Generated is fine. Save it now; the dashboard shows it
  once, and every connection string below contains it.

### 2. Copy the two connection strings

Press **Connect** at the top of the project. You want two of the three:

| Which | Port | Use it for |
|---|---|---|
| Transaction pooler | `6543` | the application (`DATABASE_URL`) |
| Session pooler | `5432` | migrations (`DATABASE_URL_UNPOOLED`) |
| Direct | `5432` | usually nothing. See the IPv6 note |

They look like this:

```
postgresql://postgres.<ref>:<password>@<pooler-host>:6543/postgres   # transaction
postgresql://postgres.<ref>:<password>@<pooler-host>:5432/postgres   # session
```

### 3. Why two, and not one

**This is the part that will waste your afternoon if you skip it.**

`src/db/migrate.ts` takes a *session-level advisory lock* so two servers booting
at once cannot both apply the same migration. Transaction mode (`6543`) hands
out a different backend per statement and silently drops session state:
advisory locks, `SET`, `LISTEN`, temporary tables. The lock would appear to be
taken and would hold nothing.

`migrationUrl()` in `src/db/client.ts` already exists for exactly this: it
prefers `DATABASE_URL_UNPOOLED` and falls back to `DATABASE_URL`. So set both
and migrations go through the session pooler while the app uses the transaction
pooler.

Two things that are already handled, so you do not need to do anything:

- **TLS.** `createPool` turns on `ssl` whenever the host is not this machine.
  Supabase refuses plaintext, so this matters, and it is automatic.
- **Prepared statements.** Transaction mode does not support them. `pg` only
  uses them for *named* queries, and nothing here names one.

### 4. IPv6

The **direct** connection (`db.<ref>.supabase.co`) is IPv6-only unless you buy
the IPv4 add-on, which is a paid plan feature. Both pooler modes are always
IPv4. If your network or your host is IPv4-only, the direct string will simply
refuse to connect and the error will not say why.

Use the session pooler for migrations rather than the direct string. It is the
same thing for our purposes and it works on both.

### 5. Point at it and migrate

```bash
# .env
DATABASE_URL=postgresql://postgres.<ref>:<password>@<pooler-host>:6543/postgres
DATABASE_URL_UNPOOLED=postgresql://postgres.<ref>:<password>@<pooler-host>:5432/postgres
```

```bash
npm run db:setup
```

Expect:

```
  applied 001_initial.sql
  applied 002_discovery_and_health.sql
  applied 003_accounts.sql
postgres: applied 3, now at 3.
```

Re-run it. It should say it is up to date and apply nothing. If it applies
anything twice, stop and say so, because that is the one thing the migrator
exists to prevent.

### 6. Check it took

In the Supabase SQL editor:

```sql
select version, name, applied_at from schema_migrations order by version;
select board_size(), universe_radius();     -- 300, 150
select orbit_of(150, 150), orbit_of(5, 5);  -- core, void
```

Then start the app against it:

```bash
DATABASE_URL=... DATABASE_URL_UNPOOLED=... npm run serve
```

An empty board is correct. The seeder only runs on `npm run dev`, which
provisions its own throwaway Postgres and ignores these variables entirely.

### 7. Things the Supabase docs will tell you that do not apply here

- **Row Level Security.** Supabase pushes RLS hard because its normal client
  talks to the database *from the browser* through PostgREST with an anon key.
  We never do that. The browser talks to our server, our server holds the
  connection string, and ownership is enforced in `src/dev-server.ts` and in
  `changeBlock`. You will see "RLS disabled" warnings in the dashboard for our
  tables. They are correct and they do not matter, **as long as you never turn
  on the PostgREST API for these tables or ship the anon key to the browser.**
  If you ever do either, the warnings become real and urgent.
- **The `anon` and `service_role` keys.** Unused. Do not put either in the
  client.
- **Generated TypeScript types.** For the PostgREST client. We write our own
  row types next to the queries.

### 8. Before it is really production

- **Connection ceiling.** `createPool` defaults to `max: 10`. On the free plan
  the pooler's own limit is small; if you run more than one instance, divide 10
  between them rather than letting each open ten.
- **Backups.** Free plan retention is short. Check what yours is before you have
  anything worth losing.
- **The `postgres` role is the owner.** Fine for one service. The day there is a
  second one, give it its own role rather than sharing this.

---

## Part 2: email, which you need before anyone else can sign in

Right now `consoleMailer()` prints the sign-in link to the server log. That is
deliberate: a link returned in an HTTP response is the shape of thing that
survives into production and turns the endpoint into "type an address, receive
their session". But it does mean nobody except you can sign in.

Supabase Auth has an email sender, but it is bound to *their* auth system, so
taking it means taking Part 3. For our sign-in links you want a plain
transactional sender: Resend, Postmark, SES. Any of them.

The work is one file. `src/auth/magiclink.ts` already defines the seam:

```ts
export interface Mailer {
  send(to: string, subject: string, body: string): Promise<void>;
}
```

Write a second implementation next to `consoleMailer()`, swap it in at
`const mailer = consoleMailer()` in `src/dev-server.ts`, and keep the console
one as the fallback when the API key is unset, the same pattern
`readPolarConfig` uses, so a missing key degrades to something usable instead of
a crash.

**Do the sender before the domain.** Every provider needs SPF and DKIM records
on your domain and a day or two of warmup, and sign-in links that land in spam
look identical to sign-in links that are broken.

---

## Part 3: only if you want Google or X sign-in

You do not need this to launch. It is here so the decision is written down.

If you want social sign-in without implementing OAuth twice, the move is to use
Supabase Auth **as an identity broker only**, not as your session system:

1. Supabase handles the OAuth round trip and hands back a JWT containing a
   verified email and provider id.
2. Your callback verifies that JWT against Supabase's JWKS, then does exactly
   what `consumeSignInLink` already does: upsert `users` by `lower(email)` or by
   `x_user_id`, and call `startSession`.
3. From that point on, nothing changes. Our cookie, our sessions table, our
   ownership checks, our revocation.

What that keeps: one session model, sign-out that really signs out, and no
second source of truth about who somebody is. What it costs: a JWKS fetch and
about a hundred lines in the callback.

What to avoid is the other arrangement, where Supabase's JWT *is* the session.
Then there are two ideas of identity, `auth.users` and `users`, and every
ownership check has to translate between them. That is where the bugs live.

---

## The short version

1. Create the project, save the password.
2. `DATABASE_URL` = transaction pooler, port 6543.
3. `DATABASE_URL_UNPOOLED` = session pooler, port 5432. Not optional: the
   migrator needs a session lock that transaction mode silently discards.
4. `npm run db:setup`, then run it again and check it applies nothing.
5. Ignore RLS, ignore the anon key, ignore the generated types.
6. Wire a transactional email sender before anybody but you tries to sign in.
7. Leave Supabase Auth alone unless you want social login, and even then use it
   only to establish identity.
