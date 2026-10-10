---
title: Remove the receipts app's own contacts table and the store switch (wave 4)
summary: The receipts app has read and written only the suite's shared contacts database since 2026-10-09. This removes the old own table, the switch back to it and every code path that touched it. Prepared and held: merging drops the table in the production receipts database on the next deploy, so it waits for Marlin's word.
type: plan
status: completed
tags: [receipts, contacts, shared-model, migration, cleanup]
projects: [receipt-ocr-app, contacts]
date: 2026-10-10
---

# Remove the receipts app's own contacts table and the store switch (wave 4)

## Status: done with the pull request that carries this document

The change was built and tested in one pull request that carried the `hold` label until Marlin
said yes in the contacts session. This document reaches the main branch only with that merge, so
its status reads completed: by the time it is on main, the removal has been released.

**What the yes unlocked:** the hold label is removed, the pull request merges, and the receipts app
deploys by itself. Its start-up applies Prisma migration `0018_drop_own_contacts_table`, which runs
`DROP TABLE "contacts"` in the production receipts database. That cannot be undone except from a
backup. The shared contacts database is a different server and is not touched.

## Why

Before the shared contact model, the receipts app kept its own `contacts` table, one list per
workspace. Wave 2 (`docs/plans/2026-10-09-shared-contacts-wave2.md`) moved it behind a switch,
`CONTACTS_STORE`, and copied the data. Since the switch was turned on in production on 2026-10-09:

- The own table is a stale second copy of personal data: 4 rows, the same 4 contacts that were
  copied to the shared database under the same ids. A repeat of the move created nothing.
- Going back is no longer meaningful. The 24 imported customers, organizations, links, customer
  numbers and custom fields exist only in the shared database, so `CONTACTS_STORE=prisma` would
  show a guest list that is missing almost everything.
- The switch is a trap: an unset variable on a new deployment would silently select the empty old
  table.

## What changes

1. **One store.** `CONTACTS_STORE`, `sharedContactsEnabled` and every branch on them are removed.
   `contactStore()` always returns the shared store for the request's company.
2. **No fallback.** A request without a company is refused (`MissingTenantError`). A missing
   `CONTACTS_DATABASE_URL` throws `ContactsNotConfiguredError`: at start it stops the server, in a
   request it surfaces as a failure and is logged. Nothing falls back to another store.
3. **Start-up always applies the contacts layout.** Unchanged otherwise: an unreachable database is
   logged and the server starts in degraded mode; a failed migration stops the start.
4. **Removed code:** `PrismaContactStore`, the own-table step of the company erasure and of the
   single-contact erase, `contacts/app-table.json` in the company export, and the finished data move
   (`scripts/move-contacts.ts`, `scripts/lib/contacts-move.ts`) with its tests. The two error codes
   that only existed for the switched-off state are removed with their wording.
5. **Database:** the `Contact` model is removed and migration `0018_drop_own_contacts_table` drops
   the table. `meal_guests`, which holds the printed copies, is not changed.
6. **Tests:** the database tests of the meal register now run against the shared store, so the test
   setup applies the contacts layout once for every database test file.

## Preconditions, all met

- The receipts database backup is verified and runs every six hours (restore proven on 2026-10-09).
- The contacts database backup is verified, restored from its off-server copy on 2026-10-09.
- Several releases have passed since the switch with no read of the own table by the running app.
- The move report was read before the move was applied: 4 contacts, one company, no merges.

## After the merge

- Confirm in the start-up log that migration 0018 applied and the contacts layout step ran.
- Remove the now unused `CONTACTS_STORE` entry from the receipts production secret project. It has
  no effect once this is deployed; removing it avoids a variable nobody reads.
- Open the contacts tab in the browser under both companies and check the counts.
- Set this plan to completed and tick the roadmap line.

## Not in this plan

Moving the business meal register to the company Whiz-Art Media, the retention purge schedule, and
the mail service link. Each has its own roadmap line.
