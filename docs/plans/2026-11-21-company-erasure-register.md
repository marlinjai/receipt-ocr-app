---
title: A company erasure removes the receipts, their files and every row of the company
summary: Until now the receiver of auth-brain's company erasure removed contact data only and still answered with success, so a company erased on 2026-11-21 left receipts, readings, decisions and stored files behind. This plan says what an erasure must delete (every table and file store, one by one), keeps legal retention apart from technical retention, adds an erasure ledger, and makes the answer say what was not erased. One question stays open for the owner, the ten-year hold on printed guest names.
type: plan
status: in-progress
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
still holds that company's data. Read-only inventory of production, 2026-11-21 14:41 Coordinated Universal Time (UTC)
(reported by the session that looked at production, not re-counted for this plan):

| Table or store | Rows | Found by |
| --- | --- | --- |
| `receipt_reviews` | 6 | company and workspace |
| `receipt_item_readings` | 6 | workspace |
| `receipt_assignment_decisions` | 6 | company and workspace |
| `dt_tables` (one receipts table per workspace) | 2, in two workspaces | workspace only: the company stamp is empty on both |
| `dt_columns` | 65 | table id |
| `dt_views` | 10 | table id |
| the physical tables `tbl_<table id>` with the receipt rows | 6 rows in one, 0 in the other | table id; no foreign key to `dt_tables` |
| `dt_rows` (the older shared layout) | 0, empty for every company | table id |
| `dt_files` | 5 (481,840 bytes) on those 6 receipts | row id; no foreign key |
| stored receipt files in Storage Brain | not counted there; 5 expected, one per `dt_files` row | file id on `dt_files` |
| `dt_relations`, `dt_row_select_values` | 0 | row id |
| `select_options` | not counted | column id |
| `sheet_import_configs` | 1 (the only one in the database) | workspace |
| `sheet_import_rows` | 53, of which 6 point at receipts that still exist | config id |

Other companies own 4 receipts tables, which must stay untouched.

Two things in this inventory decide the design below. The two receipts tables carry no company
stamp, so an erasure by stamp alone misses them and everything below them: the workspace ids
auth-brain names are needed (the erasure built here takes them from the delivery, and a database
test covers a workspace without any stamp). And neither the physical tables nor `dt_files` hang on a foreign
key, so nothing cascades to them: they are removed explicitly, files first.

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
  Observed on the server on 2026-11-21: the seven days of local dumps (oldest of 2026-11-14).
  The thirty days off the server are stated by that plan and were not verified against the real
  copies. So data erased on 2026-11-21 is in backups until about 2026-11-28 on the server and,
  by the plan, until about 2026-12-21 off the server. This document uses the later date, the
  conservative one. The
  data processing agreement (section 11.2) allows this: data in backups goes when the backup is
  replaced in the regular rotation, at the latest 90 days after the deletion. A restore from a
  backup taken before an erasure brings the erased rows back; the erasure then has to be
  delivered again (see "The erasure ledger", point 3).
- **Storage Brain files.** The receipt files (images and Portable Document Format (PDF) documents) live in Storage Brain,
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
both receipts tables of the leftovers above carry no stamp.

**The stamps and the delivery must agree, in both directions.** Before anything is touched:

- A named workspace that holds a row stamped with ANOTHER company stops the run
  (`rows_of_another_company`): the delivery would take that company's rows.
- A row stamped with the ERASED company in a workspace the delivery does NOT name stops the run
  too (`rows_outside_named_workspaces`). Auth-brain says that workspace is not, or no longer, the
  company's. The case this protects against: a workspace was moved to another company in
  auth-brain and the restamp in Receipts did not happen; deleting by the stale stamp would
  destroy the new owner's receipts and files.
- A delivery that names NO workspace is held to the same rule: every row with the company's
  stamp then lies outside the named workspaces, and the run stops. Erasing by stamp alone would
  be the one case with no second opinion, and it is reachable: a company whose only workspace
  was moved away without a restamp, and that is then deleted, names no workspace, while its
  stale stamp sits on the new owner's receipts. A company that has no rows here passes and is
  acknowledged.

One legitimate case hits the second rule and is NOT solved in Receipts: auth-brain names only the
workspaces that still exist (`listWorkspacesByTenant` leaves out deleted ones, read in its code).
A company that deleted a workspace before it was erased still has that workspace's rows here,
stamped with the company, in a workspace the delivery does not name (a company that deleted all
of them names none). Receipts cannot tell this
from a moved workspace, so it stops, the delivery fails for good after eight tries, and a person
decides: either sends the delivery again by hand with that workspace added to `workspace_ids`
(the ledger adds it to the event's list), or restamps the rows with the workspace move. The
clean fix is in auth-brain (name the deleted workspaces of the company in the delivery too) and
is on the roadmap.

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

A stored file that a living receipt outside the erasure also shows is kept (it is that receipt's
file too); only the erased company's reference to it goes, and the answer counts such files
(`stored_files_shown_elsewhere`). "Living" is checked: the row that holds the other reference
must exist in a receipts table outside the erasure. A reference whose row is in no table any
more keeps nothing: the file is deleted and the stray reference with it.

### Reached through a parent (1 table)

`sheet_import_rows`: goes with its `sheet_import_configs` row by the foreign key.

### A record about the company itself (1 table)

`company_exports`: one row per export handed to the company (a count and two hashes, no content).
Erased, last, because the rule for guest names reads it first. That an export existed at the
time of the erasure stays visible in the ledger (`exportCoverage`).

### Held, not erased (1 table): see the open question

`meal_guests`: the names of guests as printed on business meal receipts. Removed when the
company's newest export is identical to the register, otherwise held for ten years with the link
to the contact cleared. Reported in every answer. Two things were tightened in this plan, both
in the direction of holding:

- **A name that is held stays held.** "Identical export" never removes a name that already
  carries a date; only the purge does, after the date. Without this a repeat could delete what
  the first run held: the first run holds the names and removes the receipts, the register is
  then empty, and an empty register equals an export the company took before its first meal.
- **A name that never had a contact is held too** on a company erasure, with a date. Its meal
  goes with the company, so without a date it would stay for ever.

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

- `event_id`, `kind`, `company_id`, `workspace_ids` (every workspace a delivery of THIS event
  has named), `status` (received, completed, failed), `attempts`, `received_at`,
  `completed_at`, `updated_at`;
- `runs`: one entry per run with its time, its outcome, and either the counts of what it removed
  and the list of what was not erased, or the reason code of the failure with what the run had
  removed before it stopped.

What the counts mean. Every run records what that run removed. Only one run per company works
at a time (see "One run at a time"), and a stored file an earlier run already removed is counted
apart (`storedFilesAlreadyGone`), so the runs of an event add up without counting anything
twice. One case is not recorded: a run whose process died writes nothing, so the sum can be too
low, never too high. The status "completed" is what says that the recount found nothing of the
company.

An event id belongs to one company. A delivery that carries a recorded id with another company
is refused (409) before anything is erased.

Ids, counts and reason codes only, never a name. The column is called `company_id` and not
`auth_tenant_id` on purpose: the stamp marks rows an erasure removes, and this is the one row an
erasure leaves behind.

What it is for:

1. **Proof.** Auth-brain stores only the status code of an answer. What Receipts removed and did
   not remove is recorded here and can be read years later.
2. **The workspaces of an event.** A run erases over every workspace the deliveries of this
   event have named. Auth-brain sends the same body on every retry, so this changes nothing
   for it; it matters when a person sends the event again by hand with one more workspace
   (the deleted-workspace case above). The list is kept per event, not per company: another
   event for the same company starts from its own list, so a workspace named once is not
   carried into every later erasure.
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
| The body does not say what kind of event it is | 400 | nothing is erased |
| Another run for the same company is at work | 409 | `reason: already_running`; this delivery touched nothing |
| The event id is recorded for another company | 409 | `reason: event_of_another_company`; nothing was erased |
| The file store refused a file | 502 | `reason: stored_file_not_removed` |
| A named workspace holds rows stamped with another company | 502 | `reason: rows_of_another_company`; nothing was erased |
| Rows with the company's stamp lie in a workspace the delivery does not name | 502 | `reason: rows_outside_named_workspaces`; nothing was erased |
| A file was attached to a receipt of the company while the run went on | 502 | `reason: changed_during_run`; the next run removes it |
| The recount after the run still finds something of the company | 502 | `reason: rows_remain` |
| The ledger cannot be written | 502 | `reason: ledger_unavailable` |
| Any other failure | 502 | `reason: failed` |

What the recount looks at before a 200: every table with the company stamp, the export records,
the tables below the receipts tables this run removed (file references, links and choices of
their rows, columns, views, rows in the older layout, the physical tables), and the company's
contacts in the shared contacts database.

`notErased` is part of every 200 answer, so an acknowledgement never claims more than was done:

- `guest_copies_held` with the count and the date they may go (only when there are any);
- `stored_files_shown_elsewhere` with the count (only when there are any);
- `bank_sessions_not_closed` with the count (only when there are any): the connection is removed
  here and nothing is read any more, but the session at the bank could not be closed and runs
  out by itself;
- `database_backups` with `days: 30`: technical retention, ends by rotation;
- `uploads_never_attached_to_a_receipt`: cannot be assigned to a company.

A non-2xx answer makes auth-brain send the delivery again (eight times with growing pauses, then
it is shown as failed on the Erasures page, where a person can send it again). A delivery that
was acknowledged cannot be sent again from that page. Every run is
repeat-safe and goes on where the last one stopped: a stored file that is already gone is not an
error, and a file's references go as soon as the file is gone.

### One run at a time

Auth-brain waits ten seconds for an answer and then sends the delivery again. A company with
many stored files takes longer, so the second delivery can arrive while the first run is still
at work. Each run therefore holds a lock for its company (a Postgres advisory lock, held by one
open transaction, so it ends with the run and also when the process dies). A delivery that finds
the lock taken answers 409 and touches nothing; auth-brain tries again later, by which time the
first run has finished and the retry finds nothing left and answers 200. That a run continues
after auth-brain has hung up is reasoned from how the server works, not measured with a large
company; see the roadmap.

### What changes while a run goes on

The erased company's members can no longer open Receipts (auth-brain revoked their access before it
sent the delivery), so writes during a run are unlikely. They are still handled: each receipts
table is locked and its rows are read again inside the transaction that removes it, so a
receipt written after the first listing goes with the table; and a file reference that appears
after the files were removed stops the run before that table is touched, because it names a
stored file nobody has removed yet.

## Four paths (stateful-flow standard)

- **Forward:** a signed delivery erases the company, records the run, answers 200 with `notErased`.
- **Change of an earlier input:** a later delivery of the same event names other workspaces than
  the first. The run erases over the union. A named workspace that carries another company's
  stamp, or rows of the company in a workspace that is not named, stop the run before anything
  is touched.
- **Resume:** a run stops at the file store. Nothing that names a file not yet removed is gone,
  the run is recorded as failed, and the next delivery finishes it without asking for the files
  already removed.
- **Re-entry after completion:** the same delivery again answers 200, removes nothing, does not
  move the date of a held name and never removes a held name, and adds a run to the same ledger row.

Each is a test in `src/lib/__tests__/company-erasure.dbtest.ts` (real database, real table
layout, a stand-in for the file store), together with: another company keeps everything; a file
a living receipt elsewhere shows is kept and a stray reference keeps nothing; rows without a
stamp need the workspace ids; stamped rows in an unnamed workspace stop the run, also when no
workspace is named; two companies that share an account, erasing either (in
`src/lib/tax/payments/__tests__/erasure-shares.dbtest.ts`); two runs at
once; a table in the older row layout; a receipt and a file that appear during a run; a held
name surviving a repeat that reads "identical"; rows, rows below an erased receipt and contacts
that remain; a bank session left open. `src/app/api/internal/erasure/route.dbtest.ts` runs the
route itself against the real erasure and ledger (the file store refuses, then answers).

## Decided, say so if you disagree

1. **The register rows, their files and every stamped table are erased.** Follows from auth-brain
   decision 8 ("with everything else", no automatic hold) and from section 9.2 of the data
   processing agreement. Built in this change.
2. **Stored files are deleted by Receipts, before the rows.** Only `dt_files` knows which file is
   whose, and a file whose row is gone can never be found again. A refusal of the file store
   fails the run instead of being skipped.
3. **A file a living receipt outside the erasure shows is kept.** Deleting it would destroy that
   receipt's record. The answer counts it under a neutral code (`stored_files_shown_elsewhere`),
   because the other receipt may be another company's or lie in a workspace the delivery did not
   name. A reference whose row no longer exists keeps nothing: the file is deleted.
4. **Rows without a stamp are erased only in workspaces auth-brain names, and the stamps must
   agree with the delivery in both directions** (see "The stamps and the delivery must agree").
   The conservative direction for something that cannot be undone: a disagreement stops the run
   and a person looks. This holds also for a delivery that names no workspace: nothing is ever
   erased on the strength of a stamp alone. The price is that a company which deleted a
   workspace before it was erased needs a delivery sent by hand; the fix for that is auth-brain's
   (roadmap).
5. **`company_exports` is erased, the ledger is kept.** The export record is about the company;
   the ledger is the record that the erasure happened, like auth-brain keeps its erasure request.
6. **The ledger column is `company_id`.** So that no rule that works by stamp ever deletes or
   moves a ledger row.
7. **An answer is 200 only after a recount found nothing**, and it always carries `notErased`.
   Auth-brain's contract stays as it is (it reads the status only), so nothing has to change
   there for this to be honest.
8. **Backups are not rewritten.** They rotate out within thirty days (by the backup plan, see above), which the data processing
   agreement allows. Rewriting dumps would break the recovery they exist for.
9. **A held guest name stays held, and a name without a contact is held too.** No run turns
   "held" into "removed": an identical export removes only names without a date. A printed name
   that never had a contact gets its date on a company erasure, because its meal goes. No date
   is ever moved.
10. **The readme inside the export zip stays as it is.** It describes the hold, which is unchanged
    until the open question is answered.

11. **The table removal is written here and does not call the data-table package's
    `deleteTable`.** That method does the same steps (file references, links, choices, the
    physical table, views, options, columns, the table row), and the erasure follows them one by
    one. It was not reused because it swallows its own errors (a failed read of the row ids counts
    as "no rows", a failed delete of file references is ignored) and runs outside a transaction: a
    half-removed table would look like success, and it removes the file references before anyone
    has read which stored files they name. Here a failed read stops the run, and each table goes in
    one transaction. If the package gains a strict variant, switch to it.

12. **One run per company at a time, by a database lock; a second delivery answers 409.** Simpler
    and safer than making two runs agree on who removes which file.
13. **A bank session that cannot be closed does not fail the erasure, it is reported.** The
    connection is removed here, so nothing reads the account any more, and the consent at the
    bank ends by itself. Failing would block the erasure on a third party being reachable.
14. **Contacts left in the shared contacts database fail the run.** The 200 answer says the
    company is gone; the contacts are part of that.
15. **A delivery must say what it is.** A body without an event kind is refused, never taken
    for an erasure.
16. **`pnpm verify` is the check command of this repository** (`scripts/verify.sh`, named in
    `AGENTS.md`). It checks that every database URL is a local throwaway database before it
    applies the migrations. `AGENTS.md` had been ignored because the development server writes a
    block into it on every start; that is switched off in `next.config.ts` (`agentRules: false`)
    and the advice of the block is carried in the file in our own words.

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

Status `in-progress`: built and reviewed on a branch, not merged. Gates still open before it is
completed: the owner's answer to the open question above, the push and merge, the deploy with
migration `0053_erasure_events`, and the decision on the leftovers of 2026-11-21 (roadmap).

- 2026-11-21: built on branch `feat/company-erasure-register`, not pushed. `src/lib/company-erasure.ts`
  (`eraseCompany`, the classification, the recount), `src/lib/erasure-ledger.ts`, the receiver in
  `src/lib/erasure.ts` (ledger, reason codes, `notErased`), the route, migration
  `0053_erasure_events`, `pnpm verify` and `AGENTS.md`.
- 2026-11-21: one independent review of the branch, 14 findings, all fixed on the branch with
  tests. The two that could lose data: a repeat run could delete guest names the first run had
  held (now: held stays held), and an erasure by stamp could reach into a workspace the delivery
  did not name (now: it stops). Also from the review: one run per company at a time, the rows
  read again before a table goes, a wider recount including the contacts database, bank sessions
  reported, stray file references, the event kind required, the ledger tied to one company.
- Not done, each on the roadmap: the leftovers of the company erased on 2026-11-21 are still in
  production (a decision of its own, nothing is deleted until the owner says yes;
  auth-brain will not send that delivery again by itself, because it was acknowledged);
  the open question above; Storage Brain's own delete behaviour and backups are unverified; no
  run against a company with many files; uploads that never became a receipt are not counted;
  `user.erased` is not received; auth-brain does not name a company's deleted workspaces.
