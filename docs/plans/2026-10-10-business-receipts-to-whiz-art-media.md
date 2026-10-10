---
title: Business receipts move to the company Whiz-Art Media
summary: The receipts workspace that today sits under the personal company "marlinjai" holds business receipts. It moves as a whole to the business company Whiz-Art Media through auth-brain, keeping every row, file and workspace id, and "marlinjai" gets a fresh empty workspace for personal receipts. Decided 2026-10-10; the production step waits for Marlin's one-line yes.
type: plan
status: in-progress
tags: [receipts, contacts, companies, whiz-art-media, migration, production-data]
projects: [receipt-ocr-app, auth-brain, contacts]
date: 2026-10-10
---

# Business receipts move to the company Whiz-Art Media

## The rule (Marlin, 2026-10-10)

- Whiz-Art Media, the sole proprietorship, holds only what is really business. Business receipts
  belong there.
- Personal receipts, kept to build a personal spending overview, belong under the personal company
  "marlinjai".
- A receipt lives in exactly one company, chosen by tax purpose. Any receipt with a business share
  above zero lives under Whiz-Art Media and carries its share; the tax module counts only the
  business share. A receipt with no business share lives under "marlinjai". The private remainder of
  a mixed receipt is never a second copy.
- The business meal register, its receipts and its guests are business by definition.

## What production holds today (read-only, 2026-10-10, counts only)

The receipts workspace of "marlinjai" is `019fa320-8e10-7978-b0a6-0b0d3bad83c3`.

| What | Count |
|---|---|
| Receipt rows | 24 |
| in the business meal category | 16 (5 with a meal type set, 3 with guests) |
| restaurant or bar receipts in a wrong category (known extraction defect) | 2 |
| other real receipts (office supplies, a course) | 3 |
| empty rows from failed reads | 3 |
| Stored files | 23 |
| Meal guest rows | 3 |
| Tax settings rows | 1 |
| Table views | 5 |
| Rows in every finance table (decisions, vendor rules, assets, payments, invoices, reviews) | 0 |

Two facts decide the mechanism:

1. **Nothing in the data marks a receipt as personal.** "Zuordnung" (assignment) is empty on all 24.
   "Business Share %" reads 100 on 20 rows, but the code sets 100 by default for every vendor not on
   a short list, so it is not a statement. By the rule above every real receipt here is business.
2. **The finance tables are still empty.** They are all keyed by workspace and stamped with the
   company. Moving before they fill is the cheap moment.

## Decision: move the workspace, not the rows

auth-brain can move a workspace to another company (admin machine route `PATCH
/api/admin/machine/workspaces` with `tenant_id`; it rewrites the permission parent). The workspace
id, every row id and every file id stay the same, so nothing that references a receipt has to
change. Copying rows into another workspace's table would instead need new row ids, remapped select
options, re-keyed files and re-keyed guest rows, for the same result.

Decided under the "decide it yourself" rule, say so if you disagree:

- The 3 other real receipts move with the workspace as business. If one is personal, it is moved to
  the personal workspace afterwards.
- The 3 empty rows move along untouched. Removing them belongs to the extraction defects line.
- The legacy share columns stay.

## Steps

Prerequisites: a verified backup of the receipts database and of the contacts database taken the
same day; no other session's live test pass in flight; the sessions working on these receipts told
the time (see Coordination).

1. **Remove the app's own contacts table first** (pull request 61, done 2026-10-10). Independent of
   this plan, but it removed 4 company stamps that would otherwise need restamping.
2. **Shared contacts: move the 4 guests** from company "marlinjai" to Whiz-Art Media, keeping their
   ids, because meal guest rows reference them. `@marlinjai/contacts-core` 0.3.0 has the transfer
   (`transferTo`); the receipts endpoint of step 4 calls it. Three of the four are named by a meal
   and move by that; the fourth is a guest kept in the list without a meal yet and is named in
   `also_contact_ids`. No raw SQL outside the package.
3. **auth-brain:** retire the empty workspace created for Whiz-Art Media on 2026-10-09
   (`01a12296-b963-7018-8857-5e76ffe01c87`, no receipts), then move workspace
   `019fa320-8e10-7978-b0a6-0b0d3bad83c3` to Whiz-Art Media and give it the name and slug of the
   company's main workspace. The empty workspace has to give up its slug BEFORE it is retired, see
   "The production run, call by call".
4. **Receipts database: restamp the company** on every row of that workspace, dry run first, counts
   only, through the signed endpoint `POST /api/internal/workspace-move` (built 2026-10-10, see
   "The receipts endpoint" below). The tables are read from the Prisma data model instead of this
   list, which is kept as the cross-check it was written as: `meal_guests`,
   `workspace_tax_settings`, `receipt_reviews`, `dt_tables`,
   `sheet_import_configs`, `overview_selections`, `workspace_notes`, `workspace_vendor_attribution`,
   and every finance table (`tax_item_decisions`, `tax_vendor_rules`, `tax_assets`,
   `tax_asset_parts`, `tax_receipt_lines`, `tax_issued_invoices`, `tax_invoice_payments`,
   `tax_status_changes`, `tax_vat_settlements`, `tax_accounts`, `tax_import_batches`,
   `tax_payments`, `tax_payment_links`, `tax_counterparty_rules`, `tax_year_boundary_answers`).
   Reads filter by workspace, so a missed stamp hides nothing, but it leaves a wrong company on the
   row and would escape a company erasure.
5. **"marlinjai":** create a fresh workspace for personal receipts. Its table is created on first
   visit.

## The receipts endpoint (built 2026-10-10)

`src/lib/workspace-move.ts`, called through `POST /api/internal/workspace-move`, signed with its
own secret `WORKSPACE_MOVE_SECRET` like the erasure webhook, refusing without it. How to call it,
its report and the order of a move: `docs/operations/workspace-move.md`.

Decided under the "decide it yourself" rule, say so if you disagree:

- **The table list is derived, not kept by hand.** Every Prisma model with a workspace column and
  a company stamp is restamped (23 tables today, the same 23 as the list in step 4). A model with
  a company stamp and no workspace column stops the code unless it is listed as belonging to the
  company (`company_exports` is the only one), and a database test compares the derived list with
  the columns that exist. Reason: a table added later cannot be forgotten.
- **`company_exports` is not restamped.** An export record says which company took an export.
  Production holds none.
- **Contacts first, then rows, each half repeatable.** The two databases share no transaction. If
  the rows fail after the contacts moved, the call answers 502 with `step: "rows"` and a repeat
  finishes it. Reason: the contact transfer is all or nothing in the package, and a retry is the
  only recovery that needs no manual step.
- **Blockers write nothing.** A row stamped with a third company, a guest contact found in neither
  company, a contact another workspace still names, or any refusal by the contacts package other
  than a plain guest's identity conflict stops the apply with 409 before the first write. Reason:
  with the package's "skip" mode such a contact would silently stay behind while its guest rows
  moved.
- **A guest the target already has is not merged.** The source contact stays where it is and the
  guest rows of this workspace are pointed at the target's contact. Reason: the swap then points
  them back, so the rollback stays "the same call with the companies swapped". It blocks instead
  when the guest belongs to an organization, when the contact was only asked for by id, or when a
  meal already names the target's contact too (a row would have to be removed). Production has
  no such conflict (checked read-only 2026-10-10: 0 identity and 0 customer number conflicts).
- **The swap is an exact way back only while the workspace is unused under the new company.**
  What moves is "the contacts this workspace's meals name now", so a rollback starts with the
  swapped dry run and compares the number of contacts with the 4 the forward call moved.
- **Only guests move by default; others are named.** Contacts no meal names stay unless their ids
  are given in `also_contact_ids`. Reason: "all contacts of the company" has no clean inverse (the
  swap would send the 25 Whiz-Art Media clients to "marlinjai"); a list of ids does.
- **A signed call expires after five minutes** (`issued_at` is part of the signed body). Reason: a
  move has an inverse, so a signed call must not stay replayable. Within the five minutes it can
  be sent again; a single-use token was not worth a table for a call made by hand.
- **Timestamps.** The restamp goes through Prisma, so `updated_at` moves on the 17 tables that
  have it. The stamp did change at that time.

## The production run, call by call (prepared 2026-10-10, not run)

What production holds, read without writing on 2026-10-10 (counts and ids, no names):

- Receipts database, workspace `019fa320-8e10-7978-b0a6-0b0d3bad83c3`: 5 rows carry or lack the
  company stamp. `dt_tables` 1 (no stamp, from before the stamp existed), `meal_guests` 3,
  `workspace_tax_settings` 1. No row is stamped with a third company. 24 tables have the stamp
  column: the 23 the endpoint derives plus `company_exports`, which holds no row.
- Contacts database: "marlinjai" holds 4 persons, none linked to an organization, none with a
  customer number or a custom field value. 3 are named by meals. The fourth is
  `770c6be8-b497-4c14-8b46-925afa46cd5b` and goes into `also_contact_ids`, forward and on a
  rollback. Whiz-Art Media holds 25. No identity conflict and no customer number conflict.
- auth-brain: "marlinjai" has one workspace, name "Main", slug `main` (the one that moves).
  Whiz-Art Media has one, name "Main", slug `whiz-art-media` (the empty one). Each has one member.
- The empty workspace is not quite empty in the receipts database: it has a Receipts table with 0
  receipts and one tax settings row, created by a visit. They stay behind when it is retired (a
  roadmap line holds their removal).

**The slug has to be freed by hand.** auth-brain retires a workspace by marking it deleted and
keeps the row. Its route checks a slug only against live workspaces, but the table's own rule
(`UNIQUE(tenant_id, slug)`, migration `003_workspaces.sql`) also counts retired ones. Retiring the
empty workspace first and then moving the real one onto `whiz-art-media` would pass the route's
check and fail in the database. So the empty workspace is renamed first.

The sequence. Each auth-brain call goes to `/api/admin/machine/workspaces` on auth.lumitra.co with
the admin key from the secrets proxy; `actor_email` is Marlin's account.

1. Dump both databases on the server into `/root/backups-manual/` as
   `receipts-before-workspace-move-<time>.dmp` and `contacts-before-workspace-move-<time>.dmp`
   (`pg_dump -Fc` inside each database container), and read both back with `pg_restore --list`.
2. An unsigned `POST` to `/api/internal/workspace-move` must answer 401 with "Invalid signature"
   (503 would mean the secret is not loaded).
3. Signed `dry_run` with `also_contact_ids` as above. Expected: `blocked` empty, `rows.restamp` 5,
   `contacts.move` 4, `contacts.sourceAfter` 0, `contacts.targetAfter` 29. Anything else: stop and
   report, apply nothing.
4. `PATCH` the empty workspace `01a12296-b963-7018-8857-5e76ffe01c87`: slug
   `whiz-art-media-retired-20261010`, name "Main (retired 2026-10-10)".
5. `DELETE` that workspace (auth-brain marks it deleted; its one membership is revoked).
6. `PATCH` workspace `019fa320-8e10-7978-b0a6-0b0d3bad83c3`: `tenant_id`
   `019fa877-1771-7ab8-9696-c804bc32d5f3`, slug `whiz-art-media`, name "Main". If the database
   still refuses the slug (a server error; the route cannot see retired workspaces, so it cannot
   be checked beforehand), use the slug `receipts` instead. Nothing in the receipts or contacts
   database has been touched at that point.
7. Signed `apply`, at once, with the same body as step 3. A 502 with `step: "rows"` is repeated.
   Before sending it, the newest "Build & Deploy" run of the receipts app must not be in
   progress: a restart of the app in the middle of the apply is the one realistic way to stop it
   half way.
8. Signed `dry_run` again: `rows.restamp` 0, `contacts.move` 0, `contacts.alreadyAtTarget` 4.
9. `POST` a fresh workspace for "marlinjai" (`tenant_id` `019f6a90-8b72-7de9-946f-e81b2ddf3f60`,
   name "Main", slug `main`, which step 6 freed; if the database refuses it, slug `personal`).
10. The browser checks below.
11. Afterwards: tick the roadmap line and set this plan to completed; on
    `knowledge-base/ROADMAP.md`, change the admin line on the receipts queues so it says the 13
    open business meals of 2025 and the review list now live under Whiz-Art Media (asked for by
    the session that wrote that line); enter the guests and occasions of those 13 meals once
    Marlin has given them (answer page `~/software-dev/decision-pages/2026-10-10-business-meals-2025.html`).

The signed dry run of step 3 was sent once on 2026-10-10 against production and answered exactly
the expected numbers with no blocker; a read of both databases afterwards showed nothing changed.
It is sent again as the gate when the move is run.

## Verification (in the browser, by the session that runs the move)

- Under Whiz-Art Media: 24 receipts, 16 in the meal category, guests on 3 meals, the 5 views.
- A stored receipt file opens. A synthetic receipt can be created and deleted with its file.
- Contacts under Whiz-Art Media: 29 (25 plus the 4 guests). Under "marlinjai": 0.
- Under "marlinjai": an empty register.
- Do not compare cell checksums across the first page load after pull request 60: it fills the new
  "Tax Rates" column once.

## Rollback

Nothing is deleted from the receipts or the contacts database. In reverse order: retire the fresh
"marlinjai" workspace after giving up its slug `main` (rename, then `DELETE`), `PATCH` workspace
`019fa320-8e10-7978-b0a6-0b0d3bad83c3` back to `tenant_id` `019f6a90-8b72-7de9-946f-e81b2ddf3f60`
with slug `main`, then call the receipts endpoint with the two companies swapped and the same
`also_contact_ids` (`770c6be8-b497-4c14-8b46-925afa46cd5b`): it restamps back and transfers the 4
contacts back. The retired empty Whiz-Art Media workspace cannot be brought back through
auth-brain's routes; a new empty one is created in its place if it is wanted. The two dumps of
step 1 are the second line.

## Coordination

- Receipts cleanup session: no ordering need; not while its synthetic pass runs; it asserts the
  company and workspace id, so it must be told the new company name. It asked for `receipt_reviews`
  in the restamp and for a file read and delete check.
- Finance session: no objection; asked for the full finance table list above.
- The session preparing the 2025 tax return used the 16 business meals of this workspace. It must be
  asked before a time is set.

## Open

- Marlin's one-line yes for the production step.

## Done

- The contacts-core transfer operation (step 2): `@marlinjai/contacts-core` 0.3.0, 2026-10-10.
- The receipts endpoint with its dry run (steps 2 and 4), 2026-10-10 (pull request 65). It landed
  before a review had run, so a fresh agent reviewed the merged code the same day: nothing that
  touches this move, eight findings for the general case, all fixed in the follow-up pull request.
- The unused `CONTACTS_STORE` entry is gone from the production secret project, 2026-10-10.
