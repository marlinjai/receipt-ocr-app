---
title: A fast dashboard and spending page
summary: The dashboard took 3.3 to 3.7 s on the server and about 7 s in the browser, the spending page 3.1 s. Measured step by step on production, the time sits in four places, each fixed without changing what the pages show.
type: plan
status: completed
tags: [receipts, performance, dashboard, spending]
projects: [receipt-ocr-app]
date: 2026-10-26
---

# A fast dashboard and spending page

## Why

The owner clicked "View Dashboard" and "Ausgaben" and saw nothing happen (2026-10-26). The links
worked, but the pages took several seconds and showed nothing meanwhile. The loading screen
(#183) fixed the silence; this plan fixes the wait.

## What was measured

The per-step log for slow pages (#184, #185, `src/lib/timing.ts`) on production, Whiz-Art Media,
2026-10-26:

Dashboard, server 2.8 to 4.2 s:

| Step | ms |
|---|---|
| review list, building the entries (`readingOf`, which reads each receipt's stored text again) | 1,560 to 2,170 |
| review list, payments of receipts in doubt (`paidByRow`, all payments) | 400 to 510 |
| review list, the receipts table read | 250 to 285 |
| meal badge (the receipts table read again) | 330 to 570 |
| everything else (session, set-up, grouping, year counts) | under 250 |

All of these ran one after another.

Dashboard, in the browser: the page arrived after 3.1 s, the rows after 3.4 s, and then about 40
small requests ran one after another until 6.2 s. Next.js runs a page's server actions one at a
time, and the table asked for the options of each select column on its own, on every change of
its column list.

Spending, server 3.1 s:

| Step | ms |
|---|---|
| all payments, loaded three times side by side (overview, receipt checks, budgets) | 1,000 to 1,600 each |
| receipt checks: every payment compared with every receipt (`receiptCandidates`) | 910 to 970 |
| receipt checks: the receipts table read | 480 |

## Decisions

Decided by the agent, all reversible and without effect on what a page shows:

1. **A page reads each thing once.** A page render opens a scope (`withSharedReads`), and inside it
   the receipts table and the payments of a company are read once and shared. Only page renders
   open the scope: an action that writes and then reads never sees a value read before its write.
2. **The new reading of a stored receipt is kept in memory, keyed by what it is read from.** The
   reading depends only on the stored text and fields (`newReading` is pure), so the result is
   kept per content hash, at most 5,000 entries. A changed text or field is a new key; a new
   deploy starts empty. The first visit after a deploy pays the full reading once.
3. **The dashboard's independent steps run side by side**: year counts, meal badge and review list,
   after the automatic grouping (which writes) has finished.
4. **A payment looks only at receipts of its amount.** The receipts are indexed by exact euro
   amount once per run; receipts in another currency (matched within 8 percent) stay a short list
   checked for every payment. The result is the same as before, in the same order.
5. **The table asks for all select options in one request.** Calls made in the same moment are
   collected into one server action (`getSelectOptionsBatch`), so the answer is always fresh and
   the 40 requests become one per change. Up to `@marlinjai/data-table-react` 0.7.0 the table
   asked column after column and asked again for columns already loaded or on their way, so the
   asks never fell into one moment; 0.7.1 asks for every missing column at once and each column
   only once, which is what lets the batch carry them all.

Not done: storing the review results in the database. Decision 2 makes every visit after the
first fast; storing would add a migration and an invalidation rule for the same effect.

## Tests

- `withSharedReads`: one read per key inside a scope, none shared outside, a failed read not kept,
  two scopes apart.
- `newReading` cache: same result as an uncached reading, a changed field is read again, the
  bound holds, callers get copies.
- `receiptCandidates`: the indexed version returns exactly what the plain comparison returns, for
  generated payments and receipts (euro, foreign, linked, undated, both sides of each bound).
- Batched select options: calls in one moment become one action call, each caller gets its own
  column's options, a failure reaches every caller, later calls make a new request.

## Reality

After #186 (production, Whiz-Art Media, 2026-10-26, a warm server):

| | Before | After #186 |
|---|---|---|
| Dashboard, server | 2.8 to 4.2 s | 1.0 to 1.1 s |
| Dashboard, review entries | 1.6 to 2.2 s | 42 to 46 ms |
| Dashboard, everything in the browser (rows and options in) | 6.2 s | 2.7 s |
| Spending, server | 3.1 s | 1.2 to 1.3 s |
| Spending, receipt checks compared (`loop.states`) | 0.9 s | 0.17 to 0.2 s |

The first visit after a deploy still reads every receipt once (the dashboard took 4.4 s on it).

Two more steps waited for each other without reason and now overlap (the follow-up pull
request): the review list reads the payments beside the receipts, and the receipt checks read
the receipts beside the payments.

The table package (`@marlinjai/data-table-react` 0.7.0) loads the select options itself, one
column after another, and asks again for columns a load is already bringing; the dashboard's own
load of all options at once cannot stop it. That is fixed in the package (load what is missing
at once, never twice), then bumped here.

After everything (#186, #187, #188 with `@marlinjai/data-table-react` 0.7.1), production,
2026-10-26, a warm server:

| | Before | After |
|---|---|---|
| Dashboard, server | 2.8 to 4.2 s | 0.8 to 1.0 s |
| Dashboard, server actions the browser makes on a visit | 59 | 19 |
| Spending, server | 3.1 s | 1.1 to 1.3 s |

What is left is reading: the payments (0.4 to 0.5 s) and the receipts table (0.5 s) of the
company, which now run side by side. On the spending page the overlap gained little: the
database answers both reads about as slowly together as one after the other.

The time until everything is in the browser could not be measured cleanly at the end: the
measuring machine was under heavy load (load average 26 to 30), and the same page took 2.0 s on
one run and 4.4 s on the next, all of the difference in the browser's own work. On the run with
the machine least loaded it was 2.0 s, against 6.2 s at the start.

The data-table repository's checks did not run the react package's tests; they do now
(marlinjai/marlinjai-data-table#15).
