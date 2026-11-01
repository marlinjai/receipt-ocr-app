---
title: One client state for the receipts app
summary: Every page keeps its own copy of the server's data in component state, so a change on one page cannot reach anything else on screen, and numbers derived from it go stale. This plan proposes MobX stores per domain, with derived numbers as computed values and observers that redraw only what changed, moved over one page at a time. The owner decides whether it starts.
type: plan
status: draft
tags: [architecture, state, performance, frontend]
projects: [receipt-ocr-app]
date: 2026-11-01
---

# One client state for the receipts app

## Why

The owner, 2026-11-01, after the meal count in the navigation did not follow a reclassification:
it should update in real time, like MobX and observers do; state management has to be rethought
for the whole app, more performant and better.

## What is there today (read from the code, 2026-11-01)

- **No shared client state.** A server component loads a page's data and hands it to one large
  client component, which copies it into `useState`. There are about 310 `useState` calls under
  `src/app/app`, 126 of them in the finance area, and `DashboardClient` and `FinanceClient` are
  over 1,000 lines each.
- **Writes return whole views.** A server action recomputes the page's data and returns it. The
  receipt checks recompute every payment's state for each single answer (`computeStates`).
- **Keeping pages in step is done by hand:** `router.refresh()` on the spending page, callbacks,
  and `useReportNavCounts`, which reports a number from a page to the navigation. Each new number
  is a new special case, and forgetting one is the bug that started this.
- **The whole payload travels.** All 2,672 open payments reach the browser even though 30 are
  drawn, and any change redraws the large component and everything under it.
- **The data table package holds its rows itself,** through its own hook.

## Proposal

MobX, as the owner named it, because this app's problem is derived numbers: a queue, an open
count and a badge are all functions of the same records.

1. **One store per domain** (receipts, meals, payments and checks, navigation), holding records by
   id, created per company and thrown away on a company switch, so nothing of another company
   can stay on screen. The server still loads the first paint; the store takes that in once.
2. **Derived numbers are `computed`, never stored.** The navigation reads `meals.incomplete.length`
   and follows by itself. `useReportNavCounts` goes away.
3. **Rows are `observer` components,** so reclassifying one meal redraws that row and its badge,
   not the page.
4. **Writes change the store first and confirm with the server,** returning only what changed. A
   refusal rolls that record back and says so, and a late answer never overwrites a newer change.
5. **Server actions stay the only way to write.** Permissions and company scoping stay on the server.

## Order, each its own pull request

1. Meals and the navigation: the smallest domain, and the one that showed the problem. Measure
   redraws before and after.
2. Payments and receipt checks, including answers that return one record instead of the whole view.
3. Receipts on the dashboard. The hard one, because the data table package owns its rows: it needs
   a way to take rows from outside, in that package.
4. Finance tabs, one at a time.

## Risks

- Moving a screen means rewriting how it holds state, so every step needs the four test paths
  (forward, backtrack, resume, re-entry), and a step is only done when the old state is gone.
- Two sources of truth during the move: a domain moves completely or not at all.
- About 1,000-line components get split along the way, so reviews are larger than the feature suggests.

## Alternative

TanStack Query as a server cache with shared keys: less to learn and strong at refetching, but
derived numbers stay manual selectors, and a change redraws by query, not by record. It solves
staleness, not the redraw cost.
