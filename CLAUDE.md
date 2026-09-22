# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project state

BrandSpace: a public directory of personal brands laid out as a universe. A
300x300 tile board holds a disc of radius 150, divided into three priced orbits;
creators rent an N x N square, drop in an avatar and a link, and visitors browse
and click through. The product name in the UI is still FlashBrand in places; the
rename is P0 in LAUNCH.md.

Built and tested: the schema and its migrations, the claim transaction and its
concurrency tests, canvas rendering with level-of-detail sprites, the cart and
checkout with server-side pricing, the payment plumbing (webhook idempotency,
signature verification, fulfilment, refunds, lapse sweeps), featured slots,
click recording, the directory with search and categories, scarcity counters,
link health checks, growing and moving a planet, and share cards, badges and
per-planet listing pages.

Not built: accounts (everything runs as one hardcoded dev user), the Polar
checkout call itself (`/pay` answers 503), the review queue interface, a
dashboard, and a real web framework -- `src/dev-server.ts` is a `node:http`
harness, not a product server. LAUNCH.md is the plan and the honest inventory.

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Run `src/index.ts` via tsx, watching for changes |
| `npm run build` | Compile `src/` to `dist/` |
| `npm start` | Run the compiled `dist/index.js` (requires `build` first) |
| `npm run typecheck` | Type check with `--noEmit` |
| `npm test` | vitest, single run (database suites skip without `DATABASE_URL`) |
| `npm run test:db` | boots a throwaway PostgreSQL and runs the whole suite against it |
| `npm run test:watch` | vitest in watch mode |
| `npm run db:up` / `db:down` | local PostgreSQL via docker compose (port 5433) |
| `npm run db:setup` | apply any pending `db/migrations/*.sql` to `DATABASE_URL` |

Single test file: `npm test -- src/index.test.ts`
Single test by name: `npm test -- -t "runs without throwing"`

Run `npm run typecheck` before considering a change done. There is no linter or formatter configured —
`.editorconfig` (2-space indent, LF, final newline, trimmed trailing whitespace) is the only style enforcement.

`npm run clean` is `rm -rf dist`, so it needs a POSIX shell (Git Bash / WSL); it fails under cmd or PowerShell.

## Conventions that the toolchain enforces

- **ESM only** (`"type": "module"`, `module: NodeNext`). Relative imports must carry the `.js` extension even
  when the file on disk is `.ts` — `import { x } from "./thing.js"`.
- **`verbatimModuleSyntax`** is on: type-only imports must be written `import type { T } from "./t.js"`, or the
  import survives into the emitted JS and fails at runtime.
- **Strict beyond `strict`**: `noUncheckedIndexedAccess` (every index access is `T | undefined`),
  `exactOptionalPropertyTypes` (`{ a?: string }` will not accept an explicit `undefined`), `noImplicitOverride`,
  `noFallthroughCasesInSwitch`. Expect to narrow rather than assert. Per the README, loosen these only if a
  dependency genuinely can't be typed against them.
- Source in `src/`, build output in `dist/` (gitignored, along with `coverage/` and `.env*` except
  `.env.example`).
- Tests are colocated: `foo.test.ts` next to `foo.ts`.

## The invariant everything else rests on

Blocks must never overlap, and `occupied_tiles` is how that is guaranteed: one
row per occupied tile, `PRIMARY KEY (x, y)`. Overlap is a duplicate key, refused
by the storage layer. Do not replace it with a rectangle-overlap query, an
exclusion constraint, or an application-level availability check -- all three
can be raced. A claim is one transaction (`src/board/claim.ts`): sweep lapsed
reservations, insert the blocks, insert their tiles. A duplicate key means
someone won the square first: roll back, return 409 with the conflicting tiles,
never retry or relocate.

Tiles are inserted in a fixed `(x, y)` order so competing transactions contend
on the same key first and cannot deadlock.

`BOARD_SIZE` lives in `src/config.ts`, mirrored by `board_size()` in the
migrations for constraints the database enforces alone. The orbit radii are
duplicated the same way, in `orbit_of()`. `src/db/schema.test.ts` asserts both
pairs agree -- it sweeps the board and compares every tile's orbit against
`orbitAt()`. Nothing else may hardcode a board size or a radius.

## Migrations

`db/migrations/NNN_name.sql`, applied in filename order by `src/db/migrate.ts`
and recorded in `schema_migrations`. Each file runs exactly once, inside its own
transaction, under an advisory lock so two booting servers cannot both apply it.
The dev server, `db:setup` and the test harness all call `migrate()`; there is no
longer a schema file that gets re-applied on boot.

Write forward-only migrations: add a new numbered file rather than editing an
applied one, because an edit to an applied file is silently skipped on every
database that already has it. `001_initial.sql` is the old `db/schema.sql`
verbatim, which is why it is full of `IF NOT EXISTS` and later files are not.

The database-backed tests need a real PostgreSQL and say so by skipping when
`DATABASE_URL` is unset -- there is no mock, because a mock that accepted both
writers would pass while the product was broken.

## Two rules the client is held to

`src/client.test.ts` boots the real `public/app.js` against a stubbed DOM,
because the typechecker does not look at `public/` and `node --check` only
parses. It exists because a page that rendered nothing passed every other check.
An unhandled rejection during boot fails it, so a new panel that reads a field
the stub does not have is caught there rather than in a browser.

`src/site.test.ts` asserts the `[hidden]` guard still precedes any rule that
sets `display`, that nothing outside `http.js` parses a response body, and that
no `getElementById` names an id the markup does not contain.

## Import-time side effects

`src/index.ts` calls `main()` at module top level, so importing it — including from the test file — executes it.
Keep entry-point side effects behind an explicit call, or the test suite will run them on import as new code is
added.

## Configuration

`.env.example` is the template for `.env` (currently just `API_KEY`). Nothing reads it yet; there is no dotenv
dependency, so wiring env vars means adding loading code (Node 20+ supports `node --env-file`).
