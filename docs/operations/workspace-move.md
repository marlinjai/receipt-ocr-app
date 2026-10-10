---
title: Moving a receipts workspace to another company
summary: The order of a workspace move across auth-brain and the receipts app, how to call the signed receipts endpoint with a dry run first, what its report means, and how to roll back.
type: documentation
tags: [operations, workspace, companies, contacts, migration]
projects: [receipt-ocr-app, auth-brain, contacts]
date: 2026-10-10
---

# Moving a receipts workspace to another company

Which company owns a workspace is decided in auth-brain. The receipts app keeps two things
that name the company and have to follow a move:

1. The company stamp (`auth_tenant_id`) on every row of the workspace.
2. The contacts the workspace's meals name as guests, which live in the suite's shared
   contacts database under the company.

The signed endpoint `POST /api/internal/workspace-move` does both, with a dry run. Code:
`src/lib/workspace-move.ts`.

## What the endpoint does

- **Rows.** Every table that has a workspace column and a company stamp is restamped for
  that one workspace. The table list is read from the Prisma data model, so a table added
  later is covered; a database test compares the list with the columns that really exist.
  `company_exports` is left alone: an export record belongs to the company that took it.
  Only rows stamped with the source company, or not stamped at all, are rewritten. A row
  stamped with a third company blocks the move.
- **Contacts.** The contacts named by the workspace's meal guest rows move to the target
  company through `transferTo` of `@marlinjai/contacts-core` and keep their ids. A person
  and its organization move only together, so linked contacts are taken along. Contacts no
  meal names stay, unless their ids are given in `also_contact_ids`.
- **A guest the target already has** (same kind and identity): the contact stays in the
  source company and the guest rows of this workspace are pointed at the target's contact.
  Printed names on meals are never changed.

Reports and log lines carry counts and reason codes only, never a name.

## The call

The body is JSON, signed like the erasure webhook: `sha256=<hex>` of the HMAC with SHA-256
(a keyed hash, here keyed with `WORKSPACE_MOVE_SECRET`) over the exact bytes sent, in the
header `x-lumitra-erasure-signature`.

| Field | Meaning |
|---|---|
| `workspace_id` | The workspace that moved. |
| `from_tenant_id` | The company its rows are stamped with now. |
| `to_tenant_id` | The company that owns it after the move. |
| `mode` | `dry_run` or `apply`. Required, there is no default. |
| `issued_at` | Time of signing (ISO 8601). A call older or newer than five minutes is refused, so an old call cannot be replayed after a rollback. |
| `also_contact_ids` | Optional. Contacts of the source company that move along although no meal names them. |

| Answer | Meaning |
|---|---|
| 200 | The report. For a dry run this includes any blockers. |
| 400 | Body unreadable, a field missing, or the same company twice. |
| 401 | Signature missing or wrong, or `issued_at` outside five minutes. |
| 409 | An apply met a blocker. Nothing was written; the report says why. |
| 502 with `step: "rows"` | The contacts moved, the rows did not follow. Repeat the call: it finishes the move. |
| 502 | Another failure. Read the app log for the error name. |
| 503 | `WORKSPACE_MOVE_SECRET` is not configured. |

Blockers (`report.blocked`): `rows_of_another_company`, `contacts_not_found`,
`contacts_refused` (the reasons are counted in `report.contacts.refused`),
`contacts_used_by_another_workspace`, `too_many_contacts`, `changed_since_plan`.

Sign and send from a machine that has the secret in its environment, never as a command
argument (arguments are readable by every local process). In a Claude session that means
the secrets proxy with the receipts production project injected, and a script that reads
`process.env.WORKSPACE_MOVE_SECRET`:

```js
// call-move.mjs <url> <workspace> <from company> <to company> <dry_run|apply> [contact ids...]
import { createHmac } from 'node:crypto';
const [url, workspaceId, from, to, mode, ...also] = process.argv.slice(2);
const body = JSON.stringify({
  workspace_id: workspaceId,
  from_tenant_id: from,
  to_tenant_id: to,
  mode,
  also_contact_ids: also,
  issued_at: new Date().toISOString(),
});
const signature =
  'sha256=' + createHmac('sha256', process.env.WORKSPACE_MOVE_SECRET).update(body, 'utf8').digest('hex');
const res = await fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-lumitra-erasure-signature': signature },
  body,
});
console.log(res.status, await res.text());
```

## Order of a whole move

1. A fresh backup of the receipts database and of the contacts database.
2. `dry_run`. Read `report.blocked` (must be empty), `report.rows` and `report.contacts`.
   `contacts.sourceAfter` and `contacts.targetAfter` say how many contacts each company
   holds afterwards.
3. auth-brain: move the workspace with the admin machine route `PATCH
   /api/admin/machine/workspaces` (`tenant_id`). From here the app shows the workspace under
   the target company.
4. `apply`. Repeat it if it answers 502 with `step: "rows"`.
5. `dry_run` again: `rows.restamp` 0, `contacts.move` 0, `written` false.
6. In the browser, under the target company: the receipts, the meals with their guests, a
   stored file opens, the contacts.

Between steps 3 and 4 the meals show their printed guest names while the contacts are still
under the old company. Keep that gap short.

## Rolling back

Nothing is deleted by a move, so the way back is the same sequence with the companies
swapped: move the workspace back in auth-brain, then `apply` with `from_tenant_id` and
`to_tenant_id` exchanged and the same `also_contact_ids`. Guest rows that were pointed at a
target contact are pointed back, because the source contact was left in place. Rows that
carried no stamp before the move carry the source company's afterwards. The backups of
step 1 are the second line.

## What this does not do

- It does not change who owns the workspace. That is auth-brain's decision and its route.
- It does not touch the receipt rows themselves, their files or their views: they are keyed
  by the workspace and the table, which keep their ids.
- It does not merge contacts. An identity conflict leaves the source contact where it is.
