---
title: Sub rows in the receipts table, a group that holds receipts
summary: A row of the receipts table can be a group Marlin creates. Receipts sit underneath it, the group shows the sum of its receipts and never counts as a receipt itself. Needs the table package to nest rows inside grouped views (data-table-react 0.6.0), because every receipts view is grouped.
type: plan
status: completed
tags: [receipts, dashboard, sub-rows, groups, data-table, tax]
projects: [receipt-ocr-app, data-table]
date: 2026-10-11
---

# Sub rows in the receipts table, a group that holds receipts

## What is built

A **group** is a row of the receipts table that Marlin creates and names. Receipts are put under
it and taken out again. The group shows the sum of its receipts. It is a container only: it is
never a receipt, in no count and in no sum.

Later, not built now: a receipt with its parts as sub rows. The design leaves room for it (see
"Row kind" below) and does nothing else for it.

## How it is stored

- **The link** is the table's own system column `parent_row_id` on the child. It exists on every
  receipts table since the table was created; nothing has written it so far.
- **The kind** is a new text column of the receipts table, `Row Kind`, with the value `group` on a
  group and nothing on a receipt. It is added to the table definition in `src/lib/receipts-table.ts`
  and appears by itself on the next page load, like every column added before.
- **No database migration.** Both columns belong to the table package's own storage, which the
  running app creates and extends. The Prisma schema is untouched.
- **A group stores no amount.** Its sum is computed from its receipts when the table is drawn and
  exists nowhere else.

## Rules

1. One level. A group holds receipts. A group cannot lie in a group, a receipt cannot hold rows.
   The server refuses anything else.
2. A receipt is in at most one group. Putting it into another group moves it.
3. A group is recognised by its kind only, never by "has rows underneath": an empty group is still
   not a receipt.
4. A receipt in a group stays a full receipt: its own category, account, amounts and tax treatment
   count exactly as before. The group changes where it is shown, nothing else.
5. In a grouped view the receipts of a group are drawn under the group, in the section the GROUP
   belongs to, whatever their own category says. Dragging a group into another section writes the
   group's cell only; its receipts follow on screen and keep their own values.
6. A receipt whose group is not in the list (filtered out, not matched by the search, deleted by
   another path) is drawn as an ordinary top-level row. It never disappears.
7. Deleting a group releases its receipts to the top level first and then removes the group. The
   receipts are never deleted with it. Receipts that were selected together with the group are
   deleted, because they were chosen.
8. A search that finds a group shows the group with its receipts. With a filter set, a group shows
   the sum of its receipts that match the filter, like every other number on the filtered table.
9. A group only accepts its name and the columns the views group by (Category, Konto, Vendor,
   Project, Zuordnung). Amounts, dates, files and the kind itself are refused on the server, so no
   amount can ever sit on a group.
10. A group never reaches the reader: no file can be attached to it, it cannot be retaken, and it is
   not offered a new reading.

## Where receipts are counted, and how a group stays out

One predicate, in one module (`src/lib/receipts-kind.ts`): `isGroupRow` and `receiptsOnly`. Every
site below uses it and has a test built on the same fixture (a group with two receipts, a receipt
outside, an empty group, a receipt whose group is missing). Sites always test "is not a group",
never "is a receipt", because every existing row has no kind.

| Site | What happens |
| --- | --- |
| Tax module (`src/lib/tax/service.ts`, receipts for the profit calculation, the value added tax return, year boundary, assets) | reads through the shared loader, which leaves groups out |
| Review queue (`src/lib/review/service.ts`) | same loader; a group would otherwise sit in the queue forever as "amount missing" |
| Meal register, open meal count, company export of the register (`src/lib/meals/service.ts`) | same loader |
| Finance area (`/app/finance`) | reads only through the tax module |
| Overview charts (`src/lib/overview/data.ts`) | groups left out |
| Business share by vendor rule (`src/lib/overview/attribution.ts`) | groups skipped, no share is written on a group |
| Exchange rate recomputation (`src/app/app/actions.ts`) | groups skipped |
| Duplicate checks on upload (`src/lib/upload/duplicates.ts`) | a group is never a look-alike |
| Sheet import (`src/lib/sheet-import/run.ts`) | no change: it matches against its own import ledger, which never holds a group |
| Export as comma separated values (CSV) in the DATEV layout (`src/lib/export-csv.ts`) | groups left out |
| Dashboard: the item count, the board, the calendar, the assistant sidebar, the bulk edit | groups left out; the table itself shows them |
| Table: section counts and the footer | the package counts only what the app says is countable |
| Reader (`retakeReceipt`, `takeNewReading`, file upload) | refused for a group |
| Deletion (`deleteReceiptRows`, the one delete path of the app) | releases the receipts of a deleted row first |
| Moving a workspace to another company (`src/lib/workspace-move.ts`, `/api/internal/workspace-move`) | no change: groups and receipts are rows of the same table, which moves as a whole with ids and links unchanged; proven by a test |

## The flow, all four paths

Per `knowledge-base/standards/stateful-flow-testing.md`. The derived state is the group's sum and
the nesting on screen, both computed from the rows on every draw, so nothing derived is stored.

- **Forward**: create a group, put receipts in, the group shows their sum, every total elsewhere is
  unchanged.
- **Go back and revise**: take a receipt out (the sum drops, the receipt is top level again), move
  it to another group (it leaves the first), change its amount (the sum follows). Putting a receipt
  into the group it is already in writes nothing.
- **Reload**: the links, the kinds and which groups are folded come back from the database (folded
  groups are stored in the view, like folded sections).
- **After the end**: delete the group, its receipts are top level; creating a group of the same
  name starts empty; a stale link to a deleted group is drawn as top level and counted once.

## The package change

`@marlinjai/data-table-react` 0.6.0 (a minor version, from 0.5.0):

- Grouped views nest rows: a child is drawn under its parent in the parent's section and nowhere
  else, parents fold and unfold, a row whose parent is missing is top level.
- A parent can show a value computed from its children (`getSubItemSummary`), display only.
- Counts can leave rows out (`isCountedRow`): section counts and the footer.
- Dragging between sections moves top-level rows; a parent's children follow.

Built and tested on the branch, not tagged and not published. The receipts app pins `0.6.0`.

## Decisions (decided by the session, say so if you disagree)

- **An explicit kind, as text, not "has children".** An empty group must already be no receipt, and
  a text value cannot be renamed or deleted the way a select option can. Other kinds (a receipt
  with parts) are further values of the same column.
- **The kind column is hidden** in the table, the filters and the bulk edit, and the server refuses
  writes to it. Reason: turning a receipt into a group by editing a cell would silently remove it
  from the tax figures.
- **The sum is computed, never stored**, and shown for Gross, EUR Equivalent and Attributed EUR
  (amounts in one currency add up; Gross is shown only when all receipts of the group share one
  currency). Reason: a stored sum is a second amount that something will add twice.
- **The link is written by the app, not by a new package method.** The table package can create a
  row under a parent but cannot move an existing row. The app writes `parent_row_id` itself, in one
  transaction with its checks. Reason: it keeps the release to one package; a move method in the
  package is worth adding when a second app needs it.
- **One level**, enforced on the server. Reason: nothing asks for more, and every extra level
  multiplies the cases of "whose sum, whose section".
- **Children follow the group's section and keep their own values.** Reason: re-categorising
  receipts because a container was dragged would change tax figures without anyone editing a
  receipt.
- **Only top-level rows can be dragged between sections.** A nested receipt is shown where its
  group is, so dragging it would write a value with no visible effect.
- **Deleting a group never deletes receipts.** Receipts are tax records; a container is not.
- **Aggregates filter on the kind and never on the link.** A broken or stale link can therefore
  never remove a receipt from a total or count it twice.
- **The board and the calendar show receipts only.** They have no nesting.
