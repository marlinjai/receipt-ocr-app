# Receipts app: instructions for agents

Lumitra Receipts (Next.js, Prisma, PostgreSQL), in production at receipts.lumitra.co.
How the app is built and configured: `README.md`. Open work: `ROADMAP.md`. Plans: `docs/plans/`.

## The check command

```bash
pnpm verify
```

It runs every step of the continuous integration workflow (`.github/workflows/verify.yml`) in
the same order and prints one line per stage with PASS or FAIL: dependency install, the guard
against raw SQL on the shared contact tables, Prisma client generation, typecheck, lint, the unit
and component tests, the check that the test databases are throwaway ones, the migrations applied, the comparison of what the
migrations produce with `prisma/schema.prisma`, the database tests, and the roadmap check.

- The database stages need two throwaway Postgres databases. Without
  `TEST_DATABASE_URL` and `CONTACTS_TEST_DATABASE_URL` the command starts two Docker containers
  on free local ports and removes them at the end. With both set it uses those.
- The containers it starts are new on every run, so they always carry the migrations as they are in
  the checkout. A test database you keep yourself does not: a migration that was edited after you
  applied it (allowed only while it has never been merged) is not applied again, and the stage
  "migrations produce the schema" fails. Drop and recreate that database then.
- Before the migrations are applied, a stage of its own (`pnpm check:databases`) refuses every
  database URL of the run that is not local with a name ending in `_test`. The database tests
  check the same again for themselves (`test/db-guard.ts`).
- A branch is reported as done only with this command green. Say which command ran and its result.
- When the Mac is busy, run it on the second machine: `check-on-hermes pnpm verify`.
- A defect a review or production finds becomes a test or a stage of this command in the same change.

Narrower commands while working: `pnpm typecheck`, `pnpm lint`, `pnpm test` (unit and
component), `pnpm test:db` (database tests, needs the two databases), `pnpm check:roadmap`.

## Rules that bite here

- Migrations in `prisma/migrations` are written by hand and numbered. `pnpm verify` fails when
  they do not produce the schema.
- The shared contact tables are opened only through `@marlinjai/contacts-core`, never with raw SQL.
- Every row belongs to a workspace and carries the company stamp `auth_tenant_id`. A new table
  with that stamp is picked up by the workspace move and by the company erasure by itself; a
  new table without it must be classified in `UNSTAMPED_MODELS` (`src/lib/company-erasure.ts`),
  or every company erasure stops and a test fails.
- Logs, reports and ledger rows carry ids, counts and reason codes only, never a name.
- Never connect a test to anything but a local throwaway database.

## Next.js

This app runs a recent Next.js whose APIs, conventions and file layout may differ from what you
remember. Before writing Next.js code, read the guide that belongs to the installed version in
`node_modules/next/dist/docs/`, and heed deprecation notices.

The development server would otherwise write its own block with this advice into this file on
every start; that is switched off in `next.config.ts` (`agentRules: false`), so this file stays
as committed.
