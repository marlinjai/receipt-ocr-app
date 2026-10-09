---
title: Receipts app on the shared contact list (wave 2)
summary: Move the business-meal guest list of the receipts app onto the suite's shared contacts database (one PostgreSQL instance, one package, company-scoped), behind an explicit switch, with a merge-aware data move that Marlin reviews before anything is dropped.
type: plan
status: decided
tags: [receipts, contacts, shared-model, meals, migration, erasure, stateful-flow]
projects: [receipt-ocr-app, contacts, knowledge-base]
date: 2026-10-09
---

# Receipts app on the shared contact list (wave 2)

## Context

The suite decided on 2026-10-08 that people and companies who are not login users (here: the
guests of business meals) live once, in one contacts database that every app opens through the
shared package `@marlinjai/contacts-core` (repository `marlinjai/contacts`, version 0.1.0 on npm).
The architecture and the open questions are settled in
`knowledge-base/docs/plans/2026-10-07-shared-contact-model.md`. This plan covers wave 2 only: the
receipts app stops keeping its own guest list and reads and writes the shared one.

Today the receipts app keeps contacts in its own `contacts` table, one list per workspace, behind
the `ContactStore` interface in `src/lib/contacts/store.ts`. A meal (a register row) names a
contact by id and also keeps a printed copy of name and company in `meal_guests`, so an old
register prints the same names it printed when it was written.

## Decisions (from the approved build plan and the design review)

1. **Explicit switch, default off.** `CONTACTS_STORE` is `prisma` (the current table, the default)
   or `shared`. The variable `CONTACTS_DATABASE_URL` is already in the production secret project,
   so the URL alone must never select the new store. Turning production onto `shared` is a second,
   deliberate step after the data move has run and Marlin has read the merge report. The start-up
   migration, the connection handle and the erasure receiver's contact step all read this one switch.
2. **Company scope.** Contacts belong to the company (the auth-brain tenant), not the workspace.
   Every read in `src/app/app/meals/actions.ts` passes the session's company. The development
   bypass uses the fixed value of `AUTH_DEV_TENANT_ID` (default `dev-tenant`), because the contacts
   `tenant_id` column is `text`.
3. **Two-step correction, no cross-database transaction.** Correcting a contact writes the
   contact first (`contacts.update`, which is version-checked), then the printed copies on
   `meal_guests`, filtered by `contact_id` alone. The contact id is globally unique and the update
   has already proven it belongs to the company. The second step is repeatable, so saving again is
   the retry. `getMealsPageData` reconciles any drift between the printed copies and the contacts
   it just listed.
4. **Degraded mode.** The contacts database connects lazily with a pool of 3. When it is
   unreachable, the contact tab and the guest picker show an error with a retry; the meal register
   and its exports keep working from the printed copies.
5. **Start-up migration in the app, gated by the switch.** `src/instrumentation.ts` runs the
   package's `migrate()` once per server start when `CONTACTS_STORE=shared`. A connection failure
   is logged loudly and the server keeps starting (degraded mode). A failure of a real migration
   (a newer layout, a checksum mismatch) stops the start, because serving against an unknown layout
   is worse than not serving.
6. **Erasure receiver.** `POST /api/internal/erasure` copies the verified pattern of
   social-planner (raw body verified with HMAC-SHA256 before parsing, constant-time compare, fail
   closed with 503 when the secret is unset). It erases the company's contacts and its meal guest
   rows. It is repeat-safe. The secret is `RECEIPTS_ERASURE_WEBHOOK_SECRET`; until it is set the
   route answers 503 and deletes nothing. Registration in auth-brain's `suite-apps.ts` is a separate
   pull request in another repository, and only after the same real secret sits in both Infisical
   projects. The erasure step reaches the shared database whenever it is configured, not only when
   the switch is on, because the data move writes there while the switch is still off.
7. **Data move, dry run first.** A script copies the old contacts into the shared database, one
   company at a time. Identical entries of one company (same kind, name and company or role, by the
   package's identity key) merge into one contact. The winner is an active entry over an archived
   one, then the earliest created. Losers' `meal_guests` rows are repointed to the winner, and
   repointing that would duplicate a `(row, contact)` pair deletes the duplicate. The report lists
   tenant ids, winner and loser ids and counts only, never names. The script is idempotent: a
   contact that already exists under the old id counts as moved.

## Steps and pull requests

Each pull request is landed by the land-pr autopilot. Each one is small enough for CodeRabbit to
review in one pass.

1. **This plan and its roadmap line.** Documentation only.
2. **Package and handle.** Add `@marlinjai/contacts-core` and `postgres` (its peer dependency).
   `src/lib/contacts/db.ts` holds one lazy handle with `applicationName: 'receipts'`, cached on
   `globalThis` like `src/lib/prisma.ts`.
3. **Shared store.** `src/lib/contacts/shared-store.ts` implements `ContactStore` for one company.
   It translates at the boundary: receipts input to package input with `kind: 'person'`, and back
   to the receipts `Contact` shape. Package errors are rethrown as the receipts `ContactError`, so
   `failure()` in `actions.ts` keeps working. The `stale` error (version check) maps to
   `contact_invalid` until the contact screen of wave 3 handles it.
4. **Switch and company reads.** `contactStore()` in `src/lib/meals/service.ts` selects the store by
   the switch and throws `MissingTenantError` when the shared store is selected and the company is
   missing. `actions.ts` passes the company on every read. Tests cover the dev fallback and a
   session without a company.
5. **Start-up migration.** `instrumentation.ts` as in decision 5. A test covers the three outcomes:
   switch off (nothing runs), connection failure (logged, start continues), layout too new or
   checksum mismatch (start stops).
6. **Tests and continuous integration.** `test/db-setup.ts` takes `CONTACTS_TEST_DATABASE_URL` with
   the same localhost guard and runs `migrate()`. `verify.yml` adds a second Postgres service on
   port 5433 (image `postgres:17`, the production version). A guard step fails when a raw query
   touches `contacts` or `tenant_counters` outside the package, which was due with this first
   consumer.
7. **Data move script.** `scripts/move-contacts.ts`, dry run by default, with a `--apply` flag. It is
   merge-aware as in decision 7 and never prints a name.
8. **Erasure receiver.** As in decision 6, with tests for an unsigned request (401 and nothing
   deleted), a repeat (no second deletion) and a missing secret (503).

## Four-path coverage (stateful-flow standard)

- **Pick and create:** forward (create, then pick it on a meal); change an earlier input (correct
  the contact that is already on meals in two workspaces, and both printed copies change); resume
  (reload the form after a failed save, and the saved state is shown); re-entry (saving the same
  correction again changes nothing and fails nothing).
- **Merge (data move):** forward (a run moves every contact and reports counts); resume (a run that
  crashed in the middle is run again and ends with the same counts); re-entry (a run after
  completion reports zero new contacts and the same counts).
- **Erase:** forward (a signed event erases the company); re-entry (the same event sent twice
  erases nothing more and returns 2xx).

## Verification

- Receipts unit tests and database tests pass locally and in continuous integration.
- Data move, dry run on production through the piped pattern (secrets never printed): counts per
  company, the merge report and the number of guests to repoint. Marlin reads the report.
- Only after that report: `--apply`, then the counts match, then `CONTACTS_STORE=shared` is set
  in the production project. The switch change is a separate, announced step.
- Browser check on the preview with the dev-browser skill: add a guest, correct a contact that
  appears on two workspaces' meals, archive, export the register.

## Open decisions for Marlin

- Review the merge report before `--apply` (required).
- The flip of `CONTACTS_STORE` in production (after the report and a browser check).
- Registration of the erasure receiver in auth-brain needs the shared secret generated into both
  Infisical projects first. Claude generates it with the copy tool, and Marlin is told which keys.

## Not in this plan

- The contact screen (wave 3), the drop of the receipts app's own table (wave 4), and the mail
  service (wave 5, on a concrete need).
