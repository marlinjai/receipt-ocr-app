---
title: A company erasure removes the receipts, their files and every row of the company
summary: Until now the receiver of auth-brain's company erasure removed contact data only and still answered with success, so a company erased on 2026-11-21 left receipts, readings, decisions and stored files behind. This plan says what an erasure must delete (every table and file store, one by one), keeps legal retention apart from technical retention, adds an erasure ledger, and makes the answer say what was not erased. One question stays open for the owner, the ten-year hold on printed guest names.
type: plan
status: draft
tags: [receipts, erasure, gdpr, retention, storage, webhook, stateful-flow]
projects: [receipt-ocr-app, auth-brain, storage-brain]
date: 2026-11-21
---

# A company erasure removes the receipts, their files and every row of the company

## The gap

Auth-brain (the identity service of the suite) sends a signed `tenant.erased` webhook to every
application when an operator deletes a company. Each application removes what it holds of that
company and answers; auth-brain counts a 2xx answer as an acknowledgement.

On 2026-11-21 an organization with one company was erased in production. Receipts answered with
success, and auth-brain's Erasures page shows the Receipts delivery as acknowledged. Receipts
still holds that company's data. Counted on 2026-11-21 (reported by the session that looked at
production, not re-counted for this plan):

| Table | Rows | Keyed by |
| --- | --- | --- |
| `receipt_reviews` | 6 | company and workspace |
| `receipt_item_readings` | 6 | workspace |
| `receipt_assignment_decisions` | 6 | company and workspace |
| `dt_tables` (one receipts table per workspace) | 2, in two workspaces | workspace |
| below `dt_tables`: the receipt rows (`tbl_<id>`), `dt_columns`, `dt_views`, `dt_files`, `select_options`, `dt_row_select_values` | not counted yet | table id and row id |
| stored receipt files in Storage Brain | not counted yet | file id on `dt_files` |
| `sheet_import_configs` | 1 | workspace |
| below it: `sheet_import_rows` | not counted yet | config id |

The receiver's log line for that delivery was "removed 0 guest copies, held 0 (export coverage:
no_export), 0 contacts, ended 0 bank connections and 0 account shares".

The cause is not a bug in a query. `src/lib/erasure.ts` erased contact data only, on purpose, and
said so in its header ("Not covered here: the register rows and their stored receipt files in
the data layer. Those are a separate decision"). The decision was never taken in this repository,
the receiver answered 200 all the same, and Receipts kept no record of the erasures it received
(other applications keep an `erasure_events` table). So nothing between the two services could
show that the acknowledgement meant "contacts erased", not "company erased".

The data processing agreement of the suite (version 2026-11-2, section 9.2) says that on a
company erasure "each product removes what it holds of that company and acknowledges it". The
behaviour until now did not meet that sentence.

## Legal retention and technical retention are two different things

They are kept apart in this plan, in the code and in the answer of the webhook.

### Legal retention: who owes what

- **The duty to keep business records for ten years** (German tax code, the Abgabenordnung,
  section 147) is the company's. The company is the taxpayer. Lumitra provides the software.
- **Auth-brain's decision 8** (plan `docs/plans/2026-11-05-company-erasure.md` in the auth-brain
  repository, taken by the owner on 2026-11-07) settles this for the whole suite: keeping a
  company's invoices is the company's duty, not Lumitra's. A company erasure deletes its invoices
  with everything else, and nothing sets a retention hold automatically. A hold exists only when
  an operator sets it on a company on purpose, and auth-brain then refuses the erasure (it never
  reaches the applications).
- **Receipts' export-first rule** (roadmap line "Company erasure hands over an export first",
  built 2026-10-09, before decision 8) is the same thought from the other side: the company can
  take its business meal register and contacts with it as a zip (`GET /api/export/company`), so
  that it can meet its own duty after the erasure.
- **The ten-year hold on printed guest names** (`RETENTION_YEARS`, `settleGuestCopies`) is the one
  place where Receipts itself keeps something for the tax period. A business meal receipt is only
  deductible with the names of the guests. When a company's contacts are erased, the names as
  printed on its meals are removed only if the company holds an export that is identical to the
  register as it is now (`exportCoversRegister`); otherwise they are kept for ten years, with the
  link to the contact cleared. The purge that removes them after ten years is built and not
  scheduled, because no lawyer has confirmed the period (roadmap line "Enable the retention purge
  of held guest copies only after recorded legal confirmation").

Decision 8 settles everything except the last point for a company erasure. See "Open question".

### Technical retention: what survives a delete for a while, and why

None of this is a legal duty to keep. It is how the systems work, and it ends by itself.

- **Soft deletes.** Receipts has none for a company's rows. A receipt row has an archive flag
  (`_archived`) that hides it from the lists; an erasure removes archived rows like any other,
  because it drops the whole table.
- **Database backups.** Dumps of the Receipts database are taken every six hours. They are kept
  seven days on the server and up to thirty days in two copies off the server (an object store
  in the European Union and a second machine), per `docs/plans/2026-10-09-production-backups.md`.
  So data erased on 2026-11-21 is in backups until about 2026-12-21, not about 2026-11-28. The
  data processing agreement (section 11.2) allows this: data in backups goes when the backup is
  replaced in the regular rotation, at the latest 90 days after the deletion. A restore from a
  backup taken before an erasure brings the erased rows back; the erasure then has to be
  delivered again (see "The erasure ledger", point 3).
- **Storage Brain files.** The receipt files (images and PDF documents) live in Storage Brain,
  under one workspace of the Receipts application for all companies. Storage Brain's own erasure
  receiver therefore cannot tell which file belongs to which company: only Receipts can, through
  `dt_files`. Receipts must delete the files itself, and it must do so before the rows that name
  them, or the files can never be found again. Whether Storage Brain removes the object at once
  or after a grace period, and how long its own backups keep it, was not verified for this plan.

## What a company erasure deletes in Receipts

**Which rows are the company's.** Every row of the app carries the workspace it belongs to, and
since 2026-10 also a company stamp (`auth_tenant_id`). A row is erased when it carries the stamp of
the erased company, or when it carries no stamp and lies in a workspace auth-brain names in the
delivery (`workspace_ids`). This is the rule the workspace move already uses. It matters here:
several of the leftovers above could only be counted by workspace.

The list of tables is derived from the Prisma data model, not kept by hand
(`stampedModels`, already used by the workspace move). Every model without a stamp is named in
`UNSTAMPED_MODELS` with its reason. A model that is neither stops every erasure and fails a test,
so a table added later is looked at instead of skipped. 63 models today:

### Erased by the company stamp (47 tables)

`sheet_import_configs`, `workspace_vendor_attribution`, `classification_rules`,
`overview_selections`, `workspace_notes`, `workspace_tax_settings`, `tax_vendor_rules`,
`tax_reverse_charges`, `tax_item_decisions`, `tax_assignment_origins`, `tax_assets`,
`tax_asset_parts`, `tax_status_changes`, `tax_issued_invoices`, `tax_books_mirror_state`,
`tax_invoice_payments`, `tax_vat_settlements`, `tax_year_boundary_answers`, `tax_wage_statements`,
`tax_return_items`, `tax_year_settings`, `tax_accounts`, `tax_import_batches`, `tax_payments`,
`tax_counterparty_rules`, `tax_counterparty_verdicts`, `tax_payment_links`,
`tax_payment_link_removals`, `tax_receipt_lines`, `receipt_reviews`, `receipt_merges`,
`receipt_pair_decisions`, `receipt_assignment_decisions`, `spending_category_answers`,
`spending_receipt_answers`, `spending_settings`, `spending_notifications`, `spending_budgets`,
`spending_mail_searches`, `spending_mail_candidates`, `spending_push_subscriptions`,
`receipt_references`, `tax_bank_connections`, `tax_account_shares`, `receipt_items`,
`receipt_item_readings`, `receipt_item_kind_answers`.

All erased. This includes the issued invoices mirrored from Lumitra Books, the bank payments and
the wage statements: decision 8 names invoices explicitly and says "with everything else".

Two of them get a step of their own before the rows go, both built before this plan and unchanged:
`tax_bank_connections` (the session at the bank is closed first, where the bank allows it) and
`tax_account_shares` (a share with another company ends, with the links and notes the two
companies kept about each other's payments; the other company's own records stay).

### The receipts tables and what hangs below them (8 tables and one file store)

| Table or store | What it is | Erased how |
| --- | --- | --- |
| `dt_tables` | one receipts table per workspace | by stamp, last of its group: it is the only handle a repeat has |
| `tbl_<id>` | the receipt rows of one table (a physical table per `dt_tables` row) | dropped |
| `dt_rows` | receipt rows in the older shared layout | by table id |
| `dt_columns`, `dt_views` | the columns and views of a table | by table id |
| `select_options` | the options of a table's choice columns | by column id |
| `dt_files` | which stored file a receipt shows | by row id |
| `dt_relations`, `dt_row_select_values` | links and choices of a row | by row id |
| Storage Brain | the receipt files themselves | by the file ids on `dt_files`, before any row goes |

A stored file that a receipt of another company also shows is kept (it is that company's file
too); only the erased company's reference to it goes, and the answer counts such files.

### Reached through a parent (1 table)

`sheet_import_rows`: goes with its `sheet_import_configs` row by the foreign key.

### A record about the company itself (1 table)

`company_exports`: one row per export handed to the company (a count and two hashes, no content).
Erased, last, because the rule for guest names reads it first. That an export existed at the
time of the erasure stays visible in the ledger (`exportCoverage`).

### Held, not erased (1 table): see the open question

`meal_guests`: the names of guests as printed on business meal receipts. Removed when the
company's newest export is identical to the register, otherwise held for ten years with the link
to the contact cleared. Unchanged by this plan, and reported in every answer.

### Kept on purpose (1 table)

`erasure_events`: the erasure ledger, below.

### Not company data (4 tables)

| Table | Why it is not erased |
| --- | --- |
| `fx_rates` | public exchange rates, shared by all companies |
| `tax_key_versions` | bookkeeping of the app (which version of a key format is in use) |
| `tax_bank_sync_guard` | one row: when the daily bank fetch last ran |
| `google_sheets_credentials` | a person's own Google connection, keyed by the person, not by a company. A person's erasure (`user.erased`) is the event that should remove it; Receipts is not subscribed to that event today. Noted on the roadmap, outside this plan. |

### Outside the Receipts database

- **The company's contacts** in the suite's shared contacts database: erased by the existing
  rule (`eraseCompanyContacts`), unchanged.
- **Uploads that never became a receipt** (a file was stored, then reading it failed and no row
  was written): no row names them, so no company can be assigned to them. They are not erased by
  this plan and every answer says so. Inferred from the upload code, not counted in production.

## The erasure ledger

A new table `erasure_events` (migration `0053_erasure_events`), one row per delivery id:

- `event_id`, `kind`, `company_id`, `workspace_ids` (every workspace any delivery for this
  company has named), `status` (received, completed, failed), `attempts`, `received_at`,
  `completed_at`, `updated_at`;
- `runs`: one entry per run with its time, its outcome, and either the counts of what it removed
  and the list of what was not erased, or the reason code of the failure.

The counts of a run are what that run removed. A run that fails part way records its reason
and no counts, although it may have removed contacts or some files before it stopped, so the
recorded counts are a lower bound; the status "completed" is what says that the recount found
nothing of the company.

Ids, counts and reason codes only, never a name. The column is called `company_id` and not
`auth_tenant_id` on purpose: the stamp marks rows an erasure removes, and this is the one row an
erasure leaves behind.

What it is for:

1. **Proof.** Auth-brain stores only the status code of an answer. What Receipts removed and did
   not remove is recorded here and can be read years later.
2. **A repeat that names fewer workspaces.** A run erases over every workspace the ledger knows
   for the company, so rows without a stamp are still reached when a later delivery names none.
3. **After a restore.** A backup restored from before an erasure contains the erased company
   again, and the ledger of the restored database does not know the erasure. Auth-brain's
   Erasures page does, but its "send again" works only for a delivery that failed for good
   (checked in auth-brain's `requeueDeadLetteredDelivery`): an acknowledged delivery cannot be
   sent again from there today. Until it can, an operator sends the signed delivery again by
   hand. Both are written down: the step in the recovery runbook
   (`docs/operations/production-recovery.md`, "After a recovery: erased companies come back"),
   the missing button on the roadmap.

A run that cannot be recorded is not acknowledged (502): an erasure nobody can prove later is
treated as not done.

## What the webhook answers

| Situation | Status | Body |
| --- | --- | --- |
| Everything of the company is gone, or only held guest names remain | 200 | `erased` (counts per kind and per table) and `notErased` |
| The file store refused a file | 502 | `reason: stored_file_not_removed` |
| A named workspace holds rows stamped with another company | 502 | `reason: rows_of_another_company`; nothing was erased |
| The recount after the run still finds rows of the company | 502 | `reason: rows_remain` |
| The ledger cannot be written | 502 | `reason: ledger_unavailable` |
| Any other failure | 502 | `reason: failed` |

`notErased` is part of every 200 answer, so an acknowledgement never claims more than was done:

- `guest_copies_held` with the count and the date they may go (only when there are any);
- `stored_files_shown_by_another_company` with the count (only when there are any);
- `database_backups` with `days: 30`: technical retention, ends by rotation;
- `uploads_never_attached_to_a_receipt`: cannot be assigned to a company.

A non-2xx answer makes auth-brain send the delivery again (eight times with growing pauses, then
it is shown as failed on the Erasures page, where a person can send it again). A delivery that
was acknowledged cannot be sent again from that page. Every run is
repeat-safe and goes on where the last one stopped: a stored file that is already gone counts as
removed, and a file's references go as soon as the file is gone.

Auth-brain waits ten seconds for an answer. A company with many stored files takes longer. The
run then continues after auth-brain has hung up, and the next delivery finds little or nothing
left and answers 200. Reasoned from the code, not measured with a large company; see the roadmap.

## Four paths (stateful-flow standard)

- **Forward:** a signed delivery erases the company, records the run, answers 200 with `notErased`.
- **Change of an earlier input:** a later delivery names other workspaces than the first. The
  run erases over the union. A workspace that meanwhile carries another company's stamp stops
  the run before anything is touched.
- **Resume:** a run stops at the file store. Nothing that names a file not yet removed is gone,
  the run is recorded as failed, and the next delivery finishes it without asking for the files
  already removed.
- **Re-entry after completion:** the same delivery again answers 200, removes nothing, does not
  move the date of a held name, and adds a run to the same ledger row.

Each is a test in `src/lib/__tests__/company-erasure.dbtest.ts` (real database, real table
layout, a stand-in for the file store), together with: another company keeps everything; a file
shared with another company is kept; rows without a stamp need the workspace ids.

## Decided, say so if you disagree

1. **The register rows, their files and every stamped table are erased.** Follows from auth-brain
   decision 8 ("with everything else", no automatic hold) and from section 9.2 of the data
   processing agreement. Built in this change.
2. **Stored files are deleted by Receipts, before the rows.** Only `dt_files` knows which file is
   whose, and a file whose row is gone can never be found again. A refusal of the file store
   fails the run instead of being skipped.
3. **A file another company's receipt shows is kept.** Deleting it would destroy that company's
   record. The answer counts it.
4. **Rows without a stamp are erased only in workspaces auth-brain names**, and a row there with
   another company's stamp stops the run. The same rule as the workspace move; the conservative
   direction for something that cannot be undone.
5. **`company_exports` is erased, the ledger is kept.** The export record is about the company;
   the ledger is the record that the erasure happened, like auth-brain keeps its erasure request.
6. **The ledger column is `company_id`.** So that no rule that works by stamp ever deletes or
   moves a ledger row.
7. **An answer is 200 only after a recount found nothing**, and it always carries `notErased`.
   Auth-brain's contract stays as it is (it reads the status only), so nothing has to change
   there for this to be honest.
8. **Backups are not rewritten.** They rotate out within thirty days, which the data processing
   agreement allows. Rewriting dumps would break the recovery they exist for.
9. **A printed guest name without a contact also gets its date.** The old rule dated only names
   still linked to a contact; an unlinked name would have stayed for ever once its meal is gone.
   A held name now always carries the date it may go. No date is ever moved.
10. **The readme inside the export zip stays as it is.** It describes the hold, which is unchanged
    until the open question is answered.

## Open question for the owner

**Should a company erasure still hold printed guest names for ten years when no identical export
exists?**

- What it decides: after a company is erased, either nothing of it remains in Receipts, or the
  names of its meal guests (name and company as printed, no date, no place, no amount) remain for
  ten years.
- Why it is not decided here: the hold was built on purpose, it is described to the company in
  the readme of the export zip, and the retention period itself still waits for a lawyer (roadmap).
  Removing personal data cannot be undone; holding it can.
- Recommendation: **drop the hold on a company erasure, keep it for the erasure of one contact.**
  Decision 8 says the duty is the company's and that nothing sets a hold automatically; this is
  an automatic hold. After this change the meal rows are gone, so a held name is a name without
  its meal and no longer the tax record it was held for. For one erased contact of a company that
  still exists the meal is still there, and the hold keeps the company's own record complete.
- If yes to the recommendation: `eraseCompany` removes the guest copies outright, the readme in
  the export zip is reworded, and the answer no longer lists `guest_copies_held`. Small change.
- For the company erased on 2026-11-21 the question changes nothing: it had no guest copies.

## Reality

- 2026-11-21: built on branch `feat/company-erasure-register`, not pushed. `src/lib/company-erasure.ts`
  (`eraseCompany`, the classification, the recount), `src/lib/erasure-ledger.ts`, the receiver in
  `src/lib/erasure.ts` (ledger, reason codes, `notErased`), the route, migration
  `0053_erasure_events`. Tests: unit tests of the receiver and the route, eleven database tests.
- Not done, each on the roadmap: the leftovers of the company erased on 2026-11-21 are still in
  production (a decision of its own, nothing is deleted until the owner says yes to an inventory;
  auth-brain will not send that delivery again by itself, because it was acknowledged);
  the open question above; Storage Brain's own delete behaviour and backups are unverified; no
  run against a company with many files; uploads that never became a receipt are not counted;
  `user.erased` is not received.
