---
title: The Books mirror and its scheduled pull
summary: How the invoices issued in framer-clone's Books reach the "Einnahmen" tab by themselves, which settings the pull reads, how the key is set up, and the scheduled task that is described here but not created.
type: documentation
tags: [operations, books, invoices, income, framer-clone]
projects: [receipt-ocr-app, framer-clone]
date: 2026-11-08
---

# The Books mirror and its scheduled pull

Invoices are written in framer-clone's Books. This app keeps a read-only copy of each
issued invoice and credit note (`source = books` on `tax_issued_invoices`), plus
everything that is its own: the payments, the bank links, what a return declared. The
rules of the copy are in `src/lib/tax/books-mirror.ts` and decision D10 of
`docs/plans/2026-10-14-invoicing-and-income.md`. This page is about how the documents
get here.

## The pull

`pullBooksMirror` (`src/lib/tax/books-pull/service.ts`) fetches every issued invoice
and credit note of one company from the Books' read-only machine endpoint
(`GET https://app.lumitra.co/api/machine/books/documents`, framer-clone
`src/server/books/machine.ts`) with that company's API key, all pages, and hands them to
`applyBooksDocuments`, which writes the copy in one transaction. The same documents
again change nothing, and two pulls never interleave, so the schedule and the button
can both run it.

- **The schedule** (`POST /api/internal/books-pull`, a Coolify task) finds the
  company's workspace by itself: the one workspace here whose tax settings or invoices
  carry the key's company. None or several is a refusal (`no_workspace`,
  `ambiguous_workspace`), never a guess.
- **The button** "Aus den Books abholen" in the "Einnahmen" tab pulls for the person's
  active company, and only when the key belongs to that company (`other_company`
  otherwise).

**Errors are never silent.** Every pull whose workspace is known writes its outcome to
`tax_books_mirror_state` (one row per workspace): when, how, whether it landed, the
counts, every document a person must decide (a register row of the same number with
other figures, a partial credit note, an unsupported tax rate), and the documents
skipped on purpose (older than the register, not in euro). The "Einnahmen" tab shows it
above the invoices. A failure before the workspace is known (no key, a refused key, the
Books not answering) is logged as `[books-pull] schedule pull failed: <code>` and the
scheduled run exits non-zero, so the task's execution history shows it.

## Settings (Infisical, receipts project, production, read by name only)

| Name | Needed for | What it is |
|---|---|---|
| `BOOKS_PULL_KEY` | both ways | The auth-brain API key of a service account scoped to the company whose invoices are mirrored. A secret. A value starting with `PLACEHOLDER` counts as not set (the tab then says the connection is not set up). |
| `BOOKS_PULL_SECRET` | the schedule only | The shared secret of the Hash-based Message Authentication Code (HMAC) the scheduled task signs with. Machine-minted (the secrets proxy's `copy_secret` with `op=generate`). |
| `BOOKS_URL` | optional | The Books' base address; `https://app.lumitra.co` when unset. Not a secret. Plain `http` is refused except for `localhost`. |

The app reads secrets at start: restart it after changing one.

## The key

The Books endpoint takes a key only when all of this holds (framer-clone
`src/lib/auth-machine.ts`):

1. It belongs to a **service account scoped to the company** (scope type `tenant`, the
   company's id), not to a person, a tenant group or a workspace.
2. The company holds the auth-brain app grants **`books` and `sites`** (the Books live
   in the editor, which needs `sites`).
3. The service account is a **company `owner` or `admin`** (or a workspace admin of the
   company's sites workspace): reading invoices needs the same role as a person.

The service account and its key are made with auth-brain's admin machine interface
(`POST /api/admin/machine/service-accounts`, then
`POST /api/admin/machine/service-accounts/<id>/keys`, both with `AUTH_BRAIN_ADMIN_API_KEY`
as the bearer). The key is shown once: pipe it straight into `BOOKS_PULL_KEY`, never
print it.

## First pull, then the schedule

1. **Check by hand.** Finanzen, tab "Einnahmen", "Aus den Books abholen". Expect the
   panel to say when it pulled, how many invoices are new or attached, and no failure.
   The new invoices stand in the list with "aus den Books". A failure says which
   setting or grant is missing.
2. **Check the scheduled route.** Through the secrets proxy with the receipts production
   secrets injected, run `sh scripts/books-pull.sh` inside the container, or sign the body
   `{"ts":<now in Unix seconds>}` with `BOOKS_PULL_SECRET` (`sha256=` plus the hex
   HMAC-SHA256, header `x-lumitra-erasure-signature`) and POST it to
   `https://receipts.lumitra.co/api/internal/books-pull`. Never print the secret or the
   signature. Expect 200 with counts; a missing signature answers 401, the same signed
   body again 409.
3. **Scheduled task** (Coolify, on the receipts application, next to `bank-sync-daily`):
   name `books-pull-hourly`, frequency `5 * * * *` (hourly, five past), timeout 120
   seconds, command:

   ```sh
   sh scripts/books-pull.sh
   ```

   Like the bank fetch, the script loads the secrets the way the start does
   (`entrypoint.sh`, the machine identity's client id and secret from the container's
   environment, the token passed in the environment, never as an argument) and runs
   `scripts/books-pull-call.mjs`, which signs one call to the app in the same container.
   It prints the status and the answer (counts and invoice numbers, never a company or a
   figure) and exits non-zero on anything but a landed pull. Confirm the next run and
   the execution history.

Hourly is the promise: an invoice issued in the Books is in the "Einnahmen" tab within
the hour, or at once with the button.
