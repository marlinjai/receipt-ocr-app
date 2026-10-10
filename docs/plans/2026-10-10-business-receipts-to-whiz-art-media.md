---
title: Business receipts move to the company Whiz-Art Media
summary: The receipts workspace that today sits under the personal company "marlinjai" holds business receipts. It moves as a whole to the business company Whiz-Art Media through auth-brain, keeping every row, file and workspace id, and "marlinjai" gets a fresh empty workspace for personal receipts. Decided 2026-10-10; the production step waits for Marlin's one-line yes.
type: plan
status: decided
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

1. **Remove the app's own contacts table first** (pull request 61, held). Independent of this plan,
   but it removes 4 company stamps that would otherwise need restamping.
2. **Shared contacts: move the 4 guests** from company "marlinjai" to Whiz-Art Media, keeping their
   ids, because meal guest rows reference them. This needs a small addition to
   `@marlinjai/contacts-core`: a transfer of given contacts to another company in one transaction,
   which refuses and reports when a contact with the same identity already exists there (that case
   becomes a merge, with the guest rows repointed). No raw SQL outside the package.
3. **auth-brain:** retire the empty workspace created for Whiz-Art Media on 2026-10-09
   (`01a12296-b963-7018-8857-5e76ffe01c87`, no receipts), then move workspace
   `019fa320-8e10-7978-b0a6-0b0d3bad83c3` to Whiz-Art Media and give it the name and slug of the
   company's main workspace.
4. **Receipts database: restamp the company** on every row of that workspace, through Prisma, dry
   run first, counts only: `meal_guests`, `workspace_tax_settings`, `receipt_reviews`, `dt_tables`,
   `sheet_import_configs`, `overview_selections`, `workspace_notes`, `workspace_vendor_attribution`,
   and every finance table (`tax_item_decisions`, `tax_vendor_rules`, `tax_assets`,
   `tax_asset_parts`, `tax_receipt_lines`, `tax_issued_invoices`, `tax_invoice_payments`,
   `tax_status_changes`, `tax_vat_settlements`, `tax_accounts`, `tax_import_batches`,
   `tax_payments`, `tax_payment_links`, `tax_counterparty_rules`, `tax_year_boundary_answers`).
   Reads filter by workspace, so a missed stamp hides nothing, but it leaves a wrong company on the
   row and would escape a company erasure.
5. **"marlinjai":** create a fresh workspace for personal receipts. Its table is created on first
   visit.

## Verification (in the browser, by the session that runs the move)

- Under Whiz-Art Media: 24 receipts, 16 in the meal category, guests on 3 meals, the 5 views.
- A stored receipt file opens. A synthetic receipt can be created and deleted with its file.
- Contacts under Whiz-Art Media: 29 (25 plus the 4 guests). Under "marlinjai": 0.
- Under "marlinjai": an empty register.
- Do not compare cell checksums across the first page load after pull request 60: it fills the new
  "Tax Rates" column once.

## Rollback

Nothing is deleted. Move the workspace back with the same route, restamp back, transfer the 4
contacts back. The backups are the second line.

## Coordination

- Receipts cleanup session: no ordering need; not while its synthetic pass runs; it asserts the
  company and workspace id, so it must be told the new company name. It asked for `receipt_reviews`
  in the restamp and for a file read and delete check.
- Finance session: no objection; asked for the full finance table list above.
- The session preparing the 2025 tax return used the 16 business meals of this workspace. It must be
  asked before a time is set.

## Open

- Marlin's one-line yes for the production step.
- The contacts-core transfer operation (step 2).
