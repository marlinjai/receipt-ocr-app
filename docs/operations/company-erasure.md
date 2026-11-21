---
title: Company erasure in Receipts, for the operator
summary: What the receiver of auth-brain's company erasure answers, what each failure reason means and what to do about it, and where the record of an erasure is kept.
type: documentation
tags: [operations, erasure, gdpr]
projects: [receipt-ocr-app, auth-brain]
date: 2026-11-21
---

# Company erasure in Receipts, for the operator

Auth-brain (the identity service) sends a signed `tenant.erased` to
`POST /api/internal/erasure` when a company is deleted. Receipts removes the
company's receipts, stored files, contacts and every row that carries its stamp,
and answers. What it removes and why: `docs/plans/2026-11-21-company-erasure-register.md`.

## Where to look

- **Auth-brain's admin Erasures page:** whether Receipts acknowledged. It shows the
  status only.
- **The table `erasure_events` in the Receipts database** (the erasure ledger): one
  row per delivery id with `status`, `attempts` and `runs`. Each run carries its
  counts and the list of what was not erased, or the reason it failed with what it
  had removed before it stopped. Ids, counts and reason codes only.
- **The application log**, lines starting with `[erasure]`: the same, per delivery.

A 200 always lists under `notErased` what an erasure never removes (database
backups for up to thirty days, uploads that never became a receipt) and what it
did not remove this time (held guest names, files a receipt elsewhere still shows,
bank sessions that could not be closed).

## A delivery that keeps failing

Auth-brain tries eight times, then shows the delivery as failed with "send again".
The reason is in the answer and in the ledger.

| Reason | What it means | What to do |
| --- | --- | --- |
| `stored_file_not_removed` | The file store (Storage Brain) refused a file. Nothing that names a file not yet removed was deleted. | Check that Storage Brain is reachable and the Receipts key is valid, then send again. The run goes on where it stopped. |
| `rows_of_another_company` | A workspace the delivery names holds rows stamped with another company. Nothing was erased. The ledger names the tables and the workspace ids. | Find out whose the workspace is. If it was moved, finish the move (`docs/operations/workspace-move.md`), then send again. |
| `rows_outside_named_workspaces` | Rows stamped with the erased company lie in a workspace the delivery does not name, or the delivery names no workspace at all while the company has rows here. Nothing was erased. The ledger names the tables and the workspace ids the rows lie in. | Two causes. The workspace was moved to another company and the rows were not restamped: finish the move, then send again. Or the company deleted that workspace before it was erased and the delivery did not name it: send a delivery by hand that names it too (see below). |
| `changed_during_run` | A file was attached to a receipt of the company while the run went on. | Send again; the next run removes it. |
| `rows_remain` | The recount after the run still found something of the company. The ledger names the tables and counts. | Send again once. If it repeats, a table is not covered: this is a defect, look at the named table. |
| `already_running` | Another erasure, of any company, is at work. Only one works at a time. The delivery touched nothing and the event keeps its status; the ledger notes a "busy" entry. | Nothing; auth-brain's retry runs it. If it repeats for more than a few minutes with no erasure at work, a run died: its lease runs out by itself after three minutes. |
| `lease_lost` | The run's lease ran out (the process stalled) or another run took it. The run stopped at its next step; the ledger says what it had removed. | Send again; the next run goes on. |
| `event_of_another_company` | The delivery id is recorded for another company. | A defect on the sending side or a hand-made delivery with a reused id. Do not force it. |
| `ledger_unavailable` | The run could not be recorded or its lease could not be taken. Nothing was erased. | Check that migration `0053_erasure_events` is applied and the database is reachable, then send again. |
| `failed` | Anything else: the database or the contacts database was unreachable, or a defect. The ledger says what the run had removed before it stopped. | Read the `[erasure]` log line of that delivery for the error's class, fix the cause, send again. A repeat is always safe. |

## Reading the record, and finding the workspaces

All read-only. Replace the placeholders; nothing here changes a row.

The runs of every delivery for a company, newest last:

```sql
SELECT event_id, status, attempts, workspace_ids, jsonb_pretty(runs)
  FROM erasure_events WHERE company_id = '<company id>' ORDER BY received_at;
```

For `rows_of_another_company` and `rows_outside_named_workspaces` the failed run's `detail`
already carries `tables` and `workspaces` (ids only, at most fifty). To see the same without
the ledger, per table the ledger named (`dt_tables` calls the column `workspace_id`, every other
table `auth_workspace_id`):

```sql
-- In which workspaces rows with the company's stamp lie:
SELECT auth_workspace_id, count(*) FROM receipt_reviews
 WHERE auth_tenant_id = '<company id>' GROUP BY 1;
SELECT workspace_id, count(*) FROM dt_tables
 WHERE auth_tenant_id = '<company id>' GROUP BY 1;

-- Which company's stamp the rows of a named workspace carry:
SELECT auth_tenant_id, count(*) FROM receipt_reviews
 WHERE auth_workspace_id = '<workspace id>' GROUP BY 1;
```

Receipts tables without a stamp are found by workspace only:

```sql
SELECT id, workspace_id, auth_tenant_id FROM dt_tables
 WHERE workspace_id IN ('<workspace id>', '<workspace id>');
```

## Sending a delivery by hand

Needed when auth-brain cannot send it again itself: its "send again" works only
for a delivery that failed for good, not for one that was acknowledged; and it
cannot add a workspace to the body.

**Use a new event id.** The body is the one auth-brain stored for the delivery
(`kind`, `tenant_id`, `workspace_ids`, `requested_at`), with a workspace added
where that is the point, and a new `event_id` that says it was made by hand
(for example the original id with `-manual-1` appended). Why a new id and not
the original one: the ledger then shows the hand delivery as a row of its own
with its own workspaces and counts, and the row of auth-brain's delivery stays
what auth-brain actually sent. Reusing the original id also works (the
workspace list of an event only grows, so the added workspace is taken), but it
mixes the two in one row; do that only to repeat a hand delivery under its own id.

It is signed with `RECEIPTS_ERASURE_WEBHOOK_SECRET` through the secrets proxy,
so the secret is never shown, and sent to the endpoint with the signature in the
`x-lumitra-erasure-signature` header.

Before any delivery by hand, compare the workspaces it names with where the
company's rows actually lie (the queries above), including receipts tables
without a stamp.

### A 200 does not see rows without a stamp in a workspace nobody named

The recount looks at what ties to the company: its stamp, or a workspace the delivery names. A
receipts table without a company stamp in a workspace the delivery does not name is invisible
to both the erasure and the recount, and the answer is still 200. This happens when the company
deleted a workspace before it was erased and auth-brain did not name it (auth-brain is being
changed to name deleted workspaces too, on its branch `fix/erasure-invitations-and-coverage`).

#### The known case

The company erased on 2026-11-21 (auth-brain company id
`019f6a89-ea4a-75d4-90ff-4e809491647e`). Its stored delivery names one workspace,
`019fa320-8e08-7ebb-8e0e-c9faa6738c68`; an empty receipts table of it lies in
`019ee142-44af-786d-9366-a705b7607f86`, which is not named. The delivery for it must be built by
hand with both workspace ids: the stored body plus the second id, the same event kind and
company id, and a new event id. It waits for the owner's yes (roadmap decision line, the only
other place these ids are written).

An erasure is not reversible. Sending one by hand for production data needs the
owner's yes first, with the scope stated.
