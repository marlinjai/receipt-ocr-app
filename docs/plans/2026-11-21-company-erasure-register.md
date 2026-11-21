---
title: A company erasure removes the receipts, their files and every row of the company
summary: Until now the receiver of auth-brain's company erasure removed contact data only and still answered with success, so a company erased on 2026-11-21 left receipts, readings, decisions and stored files behind. This plan says what an erasure must delete (every table and file store, one by one), keeps legal retention apart from technical retention, adds an erasure ledger, and makes the answer say what was not erased. The owner decided on 2026-11-21 that a company erasure keeps nothing, printed guest names included; only the bounded retention of database backups remains.
type: plan
status: completed
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
- **The ten-year hold on printed guest names** (`RETENTION_YEARS`, `settleGuestCopies`) was the one
  place where Receipts itself kept something for the tax period. A business meal receipt is only
  deductible with the names of the guests. It applied in two cases, and since the owner's
  decision of 2026-11-21 it applies in one:
  - **One contact is erased, the company goes on:** unchanged. The names as printed on that
    company's meals are removed only if the company holds an export that is identical to the
    register as it is now (`exportCoversRegister`); otherwise they are kept for ten years, with
    the link to the contact cleared, so that the company's own register stays complete.
  - **The whole company is erased:** no hold any more. Its printed guest names are removed with
    everything else, whatever it exported.
  The purge that removes held names after ten years is built and not scheduled, because no lawyer
  has confirmed the period (roadmap line "Enable the retention purge of held guest copies only
  after recorded legal confirmation"). It still matters for the first case.

Decision 8 settled everything except the hold on a company erasure; the owner settled that on
2026-11-21 (see "Decided by the owner").

### Technical retention: what survives a delete for a while, and why

None of this is a legal duty to keep. It is how the systems work, and it ends by itself.

- **Soft deletes.** Receipts has none for a company's rows. A receipt row has an archive flag
  (`_archived`) that hides it from the lists; an erasure removes archived rows like any other,
  because it drops the whole table.
After a company erasure this is ALL that is retained, and it is bounded: database backups for
seven days on the server and at most thirty days off the server. Stored files are deleted from
the file store and cannot be restored by us (see below for what is known and what is not).

- **Database backups.** Dumps of the Receipts database are taken every six hours. They are kept
  seven days on the server and up to thirty days in two copies off the server (an object store
  in the European Union and a second machine), per `docs/plans/2026-10-09-production-backups.md`.
  Observed on the server on 2026-11-21: the seven days of local dumps (oldest of 2026-11-14).
  The thirty days off the server were verified the same day: the pull job on the second machine
  deletes dumps older than thirty days. So data erased on 2026-11-21 is in backups until about 2026-11-28 on the server and,
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
  them, or the files can never be found again. What a delete does there, read in Storage Brain's
  code on 2026-11-21: the stored object is removed from the object store right away, and only a
  metadata row marked as deleted stays; when removing the object fails, a sweeper tries again;
  there is no grace period in which a deleted file can be restored. So a deleted file cannot be
  restored by us. Not verified: whether the object store's bucket itself keeps old versions or
  has a backup. No statement is made about backups of files for that reason.

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
  destroy the new owner's receipts and files. That is a real possibility, not a theoretical
  one: auth-brain's move (`PATCH /api/admin/machine/workspaces`) rewrites only its own column
  and makes no call to Receipts, so the stamp here is stale whenever the separate restamp
  (`docs/operations/workspace-move.md`) is skipped or blocked.
- A delivery that names NO workspace is held to the same rule: every row with the company's
  stamp then lies outside the named workspaces, and the run stops. Erasing by stamp alone would
  be the one case with no second opinion, and it is reachable: a company whose only workspace
  was moved away without a restamp, and that is then deleted, names no workspace, while its
  stale stamp sits on the new owner's receipts. A company that has no rows here passes and is
  acknowledged.

One legitimate case is NOT solved in Receipts: auth-brain named only the workspaces that still
exist (`listWorkspacesByTenant` leaves out deleted ones, read in its code). A company that
deleted a workspace before it was erased still has that workspace's rows here, in a workspace
the delivery does not name (a company that deleted all of them names none). Two things follow,
and they differ:

- Rows there WITH the company's stamp stop the run (`rows_outside_named_workspaces`). Receipts
  cannot tell this from a moved workspace, so the delivery fails for good after eight tries and
  a person decides: a delivery by hand with that workspace added to `workspace_ids`, or a
  restamp with the workspace move.
- Rows there WITHOUT a stamp are not seen at all: nothing ties them to the company, neither for
  the erasure nor for the recount, and the answer is 200. This is exactly what production
  holds for the company erased on 2026-11-21 (read-only look, 2026-11-21): the stored delivery
  names one workspace, the only one still live; the second leftover receipts table (empty, with
  its columns and views, no stamp) lies in a workspace deleted earlier and therefore not named.
  The stored body sent again as it is would leave that table behind. The delivery for this
  company has to be built by hand with both workspace ids. The ids are kept in two places only:
  the roadmap decision line and the known-case section of `docs/operations/company-erasure.md`.

The clean fix is in auth-brain: name the company's deleted workspaces in the delivery too. It
went live on 2026-11-21 (auth-brain pull request #216), before this plan's change, and removes
this class for future erasures. Receipts needs no change for it: a named workspace is a named
workspace.

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
time of the erasure is not recorded any more: the erasure does not depend on it.

### Printed guest names (1 table): erased

`meal_guests`: the names of guests as printed on business meal receipts. A company erasure
removes the company's own names outright, whatever it exported (the owner's decision of
2026-11-21). The company's own names are the ones stamped with it and the ones without a stamp
in a workspace the delivery names.

- **Also a name that an earlier erasure of ONE contact had held.** Such a name carries a date
  and no contact link; it was held for a company that then still owed its records. A held row
  looks the same whichever erasure held it, and it does not need telling apart: every name in
  the company's scope is the company's data, and the company is gone. So there is no condition
  on the date, nothing is left to the purge, and the answer has no entry for held names.
- **A printed name elsewhere that names one of the company's contacts only loses its link.**
  Until this plan the rule took every printed name that pointed at one of the company's
  contacts, wherever it lay. Such a name can lie in another company's meal or in a workspace the
  delivery does not name: the normal write paths do not produce it (a meal takes guests from its
  own company's contacts, and the workspace move refuses to leave a guest pointing across
  companies), but it exists after a workspace changed company in auth-brain while its rows here
  did not follow. That printed name is the other register's record. It is not removed, and the
  answer counts it (`guestLinksCleared`).

Before the owner's decision this branch held the names on a company erasure too, and two review
findings were about making that hold safe on a repeat. With the hold gone on a company erasure
they are moot there; the part that still matters is kept in the rule for one contact (a name
that is held stays held while its company exists: an identical export never removes a name that
carries a date; the purge does after the date, or the company's erasure does).

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

What the counts mean. Every run records what that run removed. Only one erasure works at a
time (see "One erasure at a time"), and a stored file an earlier run already removed is counted
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
| Everything of the company is gone | 200 | `erased` (counts per kind and per table) and `notErased` |
| The body does not say what kind of event it is | 400 | nothing is erased |
| Another erasure (of any company) is at work | 409 | `reason: already_running`; this delivery touched nothing, the event keeps its status |
| The run's lease ran out or was taken | 502 | `reason: lease_lost`; the run stopped at its next step |
| The event id is recorded for another company | 409 | `reason: event_of_another_company`; nothing was erased |
| The file store refused a file | 502 | `reason: stored_file_not_removed` |
| A named workspace holds rows stamped with another company | 502 | `reason: rows_of_another_company`; nothing was erased; the ledger names the tables and the workspace ids |
| Rows with the company's stamp lie in a workspace the delivery does not name | 502 | `reason: rows_outside_named_workspaces`; nothing was erased; the ledger names the tables and the workspace ids |
| A file was attached to a receipt of the company while the run went on | 502 | `reason: changed_during_run`; the next run removes it |
| A receipts table could not be locked within five seconds | 502 | `reason: tables_busy`; nothing of that table was touched |
| The recount after the run still finds something of the company | 502 | `reason: rows_remain` |
| The ledger cannot be written | 502 | `reason: ledger_unavailable` |
| Any other failure | 502 | `reason: failed` |

What the recount looks at before a 200: every table with the company stamp, the export records,
the tables below the receipts tables this run removed (file references, links and choices of
their rows, columns, views, rows in the older layout, the physical tables), and the company's
contacts in the shared contacts database.

`notErased` is part of every 200 answer, so an acknowledgement never claims more than was done:

- `stored_files_shown_elsewhere` with the count (only when there are any);
- `bank_sessions_not_closed` with the count (only when there are any): the connection is removed
  here and nothing is read any more, but the session at the bank could not be closed and runs
  out by itself;
- `database_backups` with `daysOnServer: 7` and `days: 30`: the only retention after a company
  erasure, technical, ends by rotation (the thirty days off the server per the backup plan);
- `uploads_never_attached_to_a_receipt`: cannot be assigned to a company.

A non-2xx answer makes auth-brain send the delivery again (eight times with growing pauses, then
it is shown as failed on the Erasures page, where a person can send it again). A delivery that
was acknowledged cannot be sent again from that page. Every run is
repeat-safe and goes on where the last one stopped: a stored file that is already gone is not an
error, and a file's references go as soon as the file is gone.

### One erasure at a time

Auth-brain waits ten seconds for an answer and then sends the delivery again. A company with
many stored files takes longer, so the second delivery can arrive while the first run is still
at work. And when an organization with several companies is deleted, one delivery per company
arrives at the same moment.

Only one erasure works at a time in the whole app. A run takes a lease before it touches
anything: two columns on the event's row in the ledger (`lease_token`, `lease_until`), taken in
one short step that also checks that no other event holds a lease in force. A delivery that
finds one in force answers 409 and touches nothing; it is noted in the ledger as "busy" without
changing the event's status. Auth-brain tries again later, by which time the run has finished.

The lease is not a database lock on purpose. A lock is held by a database connection that stays
open for the whole run, while the run's work needs further connections from the same small pool.
Several erasures arriving together would each hold one and wait for another until the app has
none left, and ordinary requests would fail with them. A lease costs no connection while it is held.

A run renews its lease between its steps (before the register is hashed, before the guest names
are settled, before the contacts go, before and after the bank sessions are closed, before each
batch of files, before each table, before each further step). A bank that does not answer is
given ten seconds per session and then counted as "session left open". A lease that is not renewed runs out after three minutes, so a run whose
process died does not block erasures for good. A run that finds its lease gone at a step
boundary stops there (`lease_lost`) and records what it had removed; the next delivery goes on.
Once everything is removed there is no further boundary: the run counts what is left and records
its completion with its counts, also when the lease ran out in that last moment. When the
record itself cannot be written, the run gives at least its lease back, so that other erasures
are not turned away until it runs out.

That a run continues after auth-brain has hung up is reasoned from how the server works, not
measured with a large company; see the roadmap. The price of one at a time: when many companies
are erased together, the later ones are retried by auth-brain with growing pauses and complete
minutes later, not at once.

### What changes while a run goes on

The erased company's members can no longer open Receipts (auth-brain revoked their access before it
sent the delivery), so writes during a run are unlikely. They are still handled:

- Each receipts table is locked and its rows are read again inside the transaction that removes
  it, so a receipt written after the first listing goes with the table.
- File references live in a table of their own. Writers to it wait while a table's transaction
  runs, so no reference can appear between the check and the delete. A reference that is there
  at the check and names a file nobody removed stops the run before that table is touched
  (`changed_during_run`); the next run removes it.
- A writer that waited lands its reference after the table is gone. Before the recount the run
  therefore looks once more for references to the rows it removed, and removes those stored
  files and references too.
- The lock on the file references waits five seconds at most (`tables_busy` past that, the run
  is retried). That table is shared by every company: a run that waited without limit behind
  one slow writer would make every later writer of every company wait behind it.
- What remains open, accepted: a reference written after that last look, in the instant before
  the recount, is found by the recount and fails the run (`rows_remain`), but the repeat no
  longer knows the row ids and would not find it again. The failed run therefore names it in
  the ledger (the reference's id and the stored file's id), and the operator page says how it
  is removed by hand. It needs a write by a member of a company that no longer has access, in a
  window of milliseconds, so nothing more is built against it.

## Four paths (stateful-flow standard)

- **Forward:** a signed delivery erases the company, records the run, answers 200 with `notErased`.
- **Change of an earlier input:** a later delivery of the same event names other workspaces than
  the first. The run erases over the union. A named workspace that carries another company's
  stamp, or rows of the company in a workspace that is not named, stop the run before anything
  is touched.
- **Resume:** a run stops at the file store. Nothing that names a file not yet removed is gone,
  the run is recorded as failed, and the next delivery finishes it without asking for the files
  already removed.
- **Re-entry after completion:** the same delivery again answers 200, removes nothing, and adds a
  run to the same ledger row.

Each is a test in `src/lib/__tests__/company-erasure.dbtest.ts` (real database, real table
layout, a stand-in for the file store), together with: another company keeps everything; a file
a living receipt elsewhere shows is kept and a stray reference keeps nothing; rows without a
stamp need the workspace ids; several companies erased at once on a pool of two connections;
a lease that is lost, one that runs out at the very end, one nobody renewed; a file reference
that lands after its table is gone; stamped rows in an unnamed workspace stop the run, also when no
workspace is named; two companies that share an account, erasing either (in
`src/lib/tax/payments/__tests__/erasure-shares.dbtest.ts`); two runs at
once; a table in the older row layout; a receipt and a file that appear during a run; printed
guest names removed with no export, a changed export and an identical export, and a name an
earlier contact erasure held removed too while another company's keeps its date; rows, rows below an erased receipt and contacts
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
   workspace before it was erased needed a delivery sent by hand, until auth-brain named deleted
   workspaces too (live since 2026-11-21, its pull request #216).
5. **`company_exports` is erased, the ledger is kept.** The export record is about the company;
   the ledger is the record that the erasure happened, like auth-brain keeps its erasure request.
6. **The ledger column is `company_id`.** So that no rule that works by stamp ever deletes or
   moves a ledger row.
7. **An answer is 200 only after a recount found nothing**, and it always carries `notErased`.
   Auth-brain's contract stays as it is (it reads the status only), so nothing has to change
   there for this to be honest.
8. **Backups are not rewritten.** They rotate out within thirty days (by the backup plan, see above), which the data processing
   agreement allows. Rewriting dumps would break the recovery they exist for.
9. **In the rule for ONE erased contact, a held guest name stays held.** An identical export
   removes only names without a date; only the purge removes a held one. (For a company erasure
   this no longer arises: see "Decided by the owner".)
10. **The readme inside the export zip says what is true now.** Keeping records is the company's
    duty; when the company is deleted everything goes; backups keep deleted rows for seven days
    on the server and at most thirty days off it; stored files are deleted from the file store,
    a removal that fails is tried again, and a deleted file cannot be restored by us; and the rule
    for one erased contact.

11. **The table removal is written here and does not call the data-table package's
    `deleteTable`.** That method does the same steps (file references, links, choices, the
    physical table, views, options, columns, the table row), and the erasure follows them one by
    one. It was not reused because it swallows its own errors (a failed read of the row ids counts
    as "no rows", a failed delete of file references is ignored) and runs outside a transaction: a
    half-removed table would look like success, and it removes the file references before anyone
    has read which stored files they name. Here a failed read stops the run, and each table goes in
    one transaction. If the package gains a strict variant, switch to it.

12. **One erasure at a time in the whole app, by a lease on the ledger row; a delivery that
    finds one at work answers 409.** Simpler and safer than making two runs agree on who removes
    which file, and a lease holds no database connection (see "One erasure at a time"). A first
    version used a database lock per company; the second review showed that several erasures
    arriving together could use up the app's connections that way.
13. **A bank session that cannot be closed does not fail the erasure, it is reported.** The
    connection is removed here, so nothing reads the account any more, and the consent at the
    bank ends by itself. Failing would block the erasure on a third party being reachable.
14. **Contacts left in the shared contacts database fail the run.** The 200 answer says the
    company is gone; the contacts are part of that.
15. **A delivery must say what it is.** A body without an event kind is refused, never taken
    for an erasure.
16. **`pnpm verify` is the check command of this repository** (`scripts/verify.sh`, named in
    `AGENTS.md`). It checks that every database URL is a local throwaway database before it
    applies the migrations. The command is also named in `README.md` and is a script in
    `package.json`. `AGENTS.md` had been ignored on purpose: `next dev` writes into a file of
    that name on every start. What it writes is one managed block between two markers; it keeps
    everything outside them, and it can be switched off. It is switched off here
    (`agentRules: false` in `next.config.ts`, the option the development server reads before it
    writes), the ignore rule is removed, and the advice of that block is carried in the file in
    our own words. Not kept as an ignored file with the instructions elsewhere, because every
    agent harness looks for `AGENTS.md` first.

## Decided by the owner (2026-11-21)

**A company erasure keeps nothing. The ten-year hold on printed guest names no longer applies
to it.**

- The owner's reasoning, in substance: keeping records is the company's responsibility; Lumitra
  is only the software provider. When a company deletes its organization, all its data is
  deleted, with only a bounded technical retention, as the large providers do it.
- What was built from it: `eraseCompanyContacts` removes the company's printed guest names
  outright and no longer looks at exports; the export coverage and its reason codes are gone
  from the company erasure's answer and ledger entries; the readme inside the export zip and
  the answer's `notErased` list say what is true now.
- What stays: the erasure of ONE contact of a company that goes on existing keeps its rule
  (identical export removes, otherwise a ten-year hold), with its screens and wording unchanged.
- Names such an earlier erasure of one contact held go with the company too when the company is
  erased later (confirmed the same day: "all their data is deleted" leaves no exception for a
  name that carries a date).
- How "with a retention period" was read: as the bounded technical retention that exists
  anyway, namely database backups for seven days on the server and at most thirty days off the
  server (verified on 2026-11-21). Stored files
  are deleted from the file store and cannot be restored by us; nothing is claimed about a
  backup of the object store. The other possible reading, a grace period before an erasure runs (the
  data stays restorable for some days after the deletion is asked for), is NOT built and not
  decided.
- This is the same position as auth-brain's decision 8 of 2026-11-07, now stated for the one
  place in Receipts that still held something.

## Open question for the owner

None for this plan. Waiting for the owner, separately: the yes or no on erasing the leftovers
of 2026-11-21 (roadmap decision line).

## Reality

Status `completed`: merged, deployed, and used once in production for the case that started it.
What is left are follow-ups with their own roadmap lines (the dump to delete on 2026-12-21, what
is still not verified, the data-table package's table delete); none of them is part of this plan.

### In production (2026-11-21, all times Coordinated Universal Time)

- **Merged and deployed.** Pull request #257 merged at 19:56; the new container was up at about
  20:00 with migration `0053_erasure_events` applied. Auth-brain's change that names a company's
  retired workspaces in the delivery (its pull request #216) was live before it.
- **Checked before the erasure, read-only.** No stale company stamp exists in production: every
  stamped workspace agrees with auth-brain. The thirty days of off-site dumps are real: the pull
  job on the second machine deletes dumps older than thirty days. (This plan had carried the
  thirty days as "stated by the backup plan, not verified"; it is verified now.)
- **A dump first.** A dedicated dump of exactly the leftover rows was taken on the production
  host under `/root/backups/2026-11-21-receipts-erasure-leftovers/` (root only, row counts
  matching the inventory). It is to be deleted on 2026-12-21 (roadmap).
- **The erasure of the leftovers, with the owner's approval.** At about 20:03 one delivery built
  by hand, with a new event id and naming all five workspaces of the erased company, signed
  through the secrets proxy, answered 200: 2 receipts tables, 6 receipts, 5 stored files (0
  already gone, 0 kept), 6 rows each in `receipt_assignment_decisions`, `receipt_item_readings`
  and `receipt_reviews`, 1 in `sheet_import_configs`. `notErased` listed only the database
  backups (7 days on the server, 30 days off it) and uploads never attached to a receipt.
- **Verified independently afterwards.** No row in Receipts names the company or its workspaces
  except the one ledger row (status completed). The table totals moved by exactly `dt_columns`
  65, `dt_views` 10, `dt_tables` 2, `dt_files` 5, `select_options` 53, `sheet_import_rows` 53 and
  the counts above. Both physical row tables are gone. No table total of any other application
  changed. Storage Brain shows the 5 files deleted and purged.
- **What the run showed about the design.** Both receipts tables carried no company stamp and
  one lay in a workspace retired before the company was erased; they were reached because the
  delivery named every workspace. The counts of the answer matched the inventory taken before
  (`select_options`, uncounted then, was 53).

### How it was built

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
- 2026-11-21: a second look by the reviewer, 7 findings, all fixed. The lock that kept a
  database connection open for a whole run is replaced by a lease on the ledger row (one erasure
  at a time in the whole app); a lost lease stops a run at its next step and a completion is
  always recorded with its counts; a conflict names the workspace ids; file references are
  locked during a table's removal and looked for once more afterwards.
- 2026-11-21: a third look at the lease, 5 findings, all fixed: the lock on the file references
  has a time limit, more lease checkpoints and a time limit on the bank, the lease is given back
  when a run cannot be recorded, a left file reference is named in the ledger, and `AGENTS.md`
  says when a kept test database has to be recreated.
- 2026-11-21: the owner decided the open question. The hold on printed guest names is removed
  from the company erasure; the erasure of one contact keeps it.
- Still open after completion, each with its own roadmap line: the dump of the leftovers is
  deleted on 2026-12-21; whether the object store behind Storage Brain keeps old versions or a
  backup is unverified; no run against a company with many files; uploads that never became a
  receipt are not counted; `user.erased` is not received; the data-table package's table delete
  swallows errors.
