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
| `rows_of_another_company` | A workspace the delivery names holds rows stamped with another company. Nothing was erased. The ledger names the tables. | Find out whose the workspace is. If it was moved, finish the move (`docs/operations/workspace-move.md`), then send again. |
| `rows_outside_named_workspaces` | Rows stamped with the erased company lie in a workspace the delivery does not name, or the delivery names no workspace at all while the company has rows here. Nothing was erased. The ledger names the tables. | Two causes. The workspace was moved to another company and the rows were not restamped: finish the move, then send again. Or the company deleted that workspace before it was erased (auth-brain names only workspaces that still exist): send the delivery again by hand with that workspace added to `workspace_ids` (see below). |
| `changed_during_run` | A file was attached to a receipt of the company while the run went on. | Send again; the next run removes it. |
| `rows_remain` | The recount after the run still found something of the company. The ledger names the tables and counts. | Send again once. If it repeats, a table is not covered: this is a defect, look at the named table. |
| `already_running` | Another run for the same company is at work. | Nothing; the retry finds it finished. |
| `event_of_another_company` | The delivery id is recorded for another company. | A defect on the sending side or a hand-made delivery with a reused id. Do not force it. |
| `ledger_unavailable` | The run could not be recorded. | Check that migration `0053_erasure_events` is applied, then send again. |

## Sending a delivery by hand

Needed when auth-brain cannot send it again itself: its "send again" works only
for a delivery that failed for good, not for one that was acknowledged; and it
cannot add a workspace to the body.

The body is the one auth-brain stored for the delivery (`event_id`, `kind`,
`tenant_id`, `workspace_ids`, `requested_at`), with a workspace added where that
is the point. It is signed with `RECEIPTS_ERASURE_WEBHOOK_SECRET` through the
secrets proxy, so the secret is never shown, and sent to the endpoint with the
signature in the `x-lumitra-erasure-signature` header. The workspace list of an
event only grows: a workspace named once for an event stays named for it.

### A 200 does not see rows without a stamp in a workspace nobody named

The recount looks at what ties to the company: its stamp, or a workspace the delivery names. A
receipts table without a company stamp in a workspace the delivery does not name is invisible
to both the erasure and the recount, and the answer is still 200. This happens when the company
deleted a workspace before it was erased and auth-brain did not name it (auth-brain is being
changed to name deleted workspaces too, on its branch `fix/erasure-invitations-and-coverage`).

The known case: the company erased on 2026-11-21 (auth-brain company id
`019f6a89-ea4a-75d4-90ff-4e809491647e`). Its stored delivery names one workspace,
`019fa320-8e08-7ebb-8e0e-c9faa6738c68`; an empty receipts table of it lies in
`019ee142-44af-786d-9366-a705b7607f86`, which is not named. The delivery for it must be built by
hand with both workspace ids: the stored body plus the second id, the same event kind and
company id, and a new event id because the body differs. It waits for the owner's yes (roadmap).

Before any delivery by hand, compare the workspaces it names with where the company's rows
actually lie, including tables without a stamp.

An erasure is not reversible. Sending one by hand for production data needs the
owner's yes first, with the scope stated.
