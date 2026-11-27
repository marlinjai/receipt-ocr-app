---
title: Receipts review - load time, installed app and navigation
summary: A measured review of why the receipts app feels slow, how far it is a real installed app, and where navigation hurts. Four passes on production (headless browser, frontend code, server timing logs, the PWA state). The slowness has three main causes, each measured, the largest being that every page reads every payment of the company on the server (0.6 to 1.75 s in the log; the dashboard is slower than after the October fix) and that the sidebar's two numbers re-ran the dashboard's review list on every click. Fixed on a local branch, not deployed - the sidebar numbers, the spending page's 20,000 hidden table elements, and the manifest and icons. What remains is ordered by value.
type: plan
status: draft
tags: [receipts, review, performance, pwa, navigation, ux]
projects: [receipt-ocr-app]
date: 2026-11-26
---

# Receipts review: load time, installed app and navigation

Marlin asked (2026-11-26) for a performance, Progressive Web App (PWA) and user experience (UX)
review of the receipts app, because it loads slowly, is not really optimised as an installed app,
and its navigation feels weak. The method follows the dashboard review of 2026-11-10
(`claude-session-dashboard/plans/2026-11-10-dashboard-review.md`): measure first, then read the
code, and say for every finding whether it was **measured or read** (verified) or **inferred**
(assumed).

**How it was done, on 2026-11-27, against production (receipts.lumitra.co, Whiz-Art Media, 1,312
receipts):**

1. Every page measured in the headless automation browser, signed in, desktop viewport: document
   timing, Largest Contentful Paint (LCP, when the main content is painted), Cumulative Layout Shift
   (CLS, how much the page jumps), main-thread task time, elements, script size, every request with
   its Next.js headers, idle frame rate; then each page reached by a click in the sidebar
   ("soft navigation"). Read-only: no click that writes.
2. The frontend read for causes: page components, the shell, the stores, the navigation.
3. The server: the per-step timing log every page over 700 ms already writes (`src/lib/timing.ts`),
   read from the production container log; the data flow behind each page; cache headers.
4. The PWA: manifest, service worker, installability asked from Chrome itself
   (`Page.getInstallabilityErrors`, `Page.getAppManifest`), icons, metadata.

Caveats on the numbers. The Mac ran at a load average of 190 to 250 during part of the session, and
the automation profile carries a password manager extension (a 457 KB script in every page, which
inflates the browser's script time on every page alike). The second batch (contacts, tools, rules,
import, and the warm runs of finance, spending and meals) ran under that load: its frame rates (26 to
45 per second on light pages) are not reported, and its load and blocking figures are marked as
such in the table. The first batch (upload, receipts, overview, and the cold runs of finance,
spending and meals) and every server-side figure come from the server's own log or ran before the
load rose. A
phone run with a throttled processor was not done (see "Not measured").

## The short version

- **On a desktop processor the server is the bottleneck, not the browser** (a phone run is still open). Every page waits for one full read of every
  payment of the company (`payments.read`, 585 to 1,752 ms in today's log), and the dashboard then
  builds the review list and the meal register on top. Warm against warm, the dashboard took 1.0 to
  1.1 s on the server after the October fix (`2026-10-26-fast-dashboard-and-spending.md`) and takes
  1.7 to 1.9 s today; the 3.3 and 3.6 s lines came right after a deploy, which pays a one-off read.
- **Every click in the sidebar paid for the dashboard's work again.** The two numbers in the sidebar
  ("Belege 5", "Bewirtung 9") were recounted on every page change through a server action that runs
  the review list and the meal register: 1.2 to 3 s of server work per click, and as a server action
  it held every later action of the page (a save, a filter) in line behind it. **Fixed.**
- **The spending page builds 28,435 elements, 20,401 of them in a closed table.** It sends 3.4 MB of
  HTML and blocks the main thread for 0.27 to 0.5 s. **Fixed in part** (the closed table and the
  long "Unklar" list); the 1.8 MB of serialized data remain.
- **The app is installable and its service worker is registered,** but the manifest still said
  "Receipt OCR", had SVG icons only (iOS shows a screenshot as the home screen icon), and the pages
  declared English while written in German. **Fixed.** The page also blocks pinch zoom; that change
  waits for proof on phone screenshots.
- **Navigation:** a sidebar click shows "Wird geladen…" for as long as the server needs: 1.2 s to
  the overview, 1.7 s to the receipts, 3.4 s to finance, 4.1 s to spending. Nothing is kept
  between visits, because every page is rendered per request and the router keeps no copy. That is
  the felt slowness, and only the server work above shortens it.

## Measured on production (before)

Cold means the browser cache was cleared first. "Server" is the page's line in the timing log where
one exists (pages under 700 ms write none).

| Page | Document ready (cold) | Main content painted (LCP) | HTML | Elements | Main-thread blocking (> 50 ms parts) | Server (log) |
|---|---|---|---|---|---|---|
| Upload (`/app`) | 0.49 s | 0.73 s | 31 KB | 249 | 0 ms | under 0.7 s |
| Receipts (`/app/dashboard`) | 1.78 s | 1.93 s | 29 KB | 409 (groups closed) | 0 ms | 1.7 to 3.6 s |
| Overview | 1.53 s | 1.53 s | 703 KB | 4,318 | 45 ms | not logged |
| Finance | 3.80 s | 3.83 s | 1,261 KB | 356 | 33 to 43 ms | not logged (no measurement around it) |
| Spending | 3.50 s | 3.68 s | 3,398 KB | 28,435 | 273 to 502 ms | 2.0 to 3.1 s |
| Meals | 1.60 s | 1.61 s | 90 KB | 512 | 20 ms | under 0.7 s |
| Contacts, rules, tools, import (under load, see caveats) | 0.34 to 1.17 s | 0.38 to 1.19 s | 27 to 71 KB | 227 to 526 | 31 to 367 ms | under 0.7 s |

Every page: 10 to 13 script files, 553 to 1,076 KB of script (176 to 327 KB on the wire), 81 KB of
CSS, all with `cache-control: public, max-age=31536000, immutable` and gzip. Documents are gzip as
well and `no-store`. The receipts page jumps once by 0.29 to 0.56 (CLS; above 0.25 counts as poor)
when the table arrives, 1.7 s after the start: the filter row and the table container move.

Soft navigation, a click in the sidebar until "Wird geladen…" is gone (desktop, one run each):

| To | Time |
|---|---|
| Receipts | 1.70 s |
| Spending | 4.07 s |
| Finance | 3.39 s |
| Overview | 1.18 s |
| Meals | 1.29 s |
| Rules, tools | 0.36 s |

Contacts is left out: it has a loading file of its own, so the wait condition held at once (209
elements at that moment, 526 when loaded); a figure for it needs another condition.

Server steps from the production log (today, after the 13:05 deploy; the first lines after a deploy
include the one-off reading of every receipt):

| Step | ms |
|---|---|
| `payments.read` (every payment, its links, accounts, rules, verdicts) | 585 to 1,752 |
| `payments.funding` | 140 to 249 |
| Dashboard review list (`review`, contains the payments read) | 1,631 to 3,273 |
| Dashboard meal register (`meals`, overlaps it) | 1,159 to 2,753 |
| Spending receipt checks (`checks.loop`) | 1,570 to 2,907 |
| Spending receipts read for the checks (`loop.receipts`) | 981 to 2,212 |

## Findings

### Server

- **S1. Every page reads every payment of the company** (verified: log and
  `src/lib/tax/payments/service.ts`, `readPayments`). Six queries side by side, the payment query
  with every link, ordered, unbounded; then the funding resolution over all of them. `withSharedReads`
  keeps it to one read per page, but one read shows 0.6 to 1.75 s and it grows with every imported
  statement. It is the single largest cost in the dashboard, spending, the sidebar numbers and
  finance. Two limits on that figure: steps that run side by side slow each other, as the timing
  helper itself notes, so the read alone may be faster than the log says; and that the time is in
  the database rather than in waiting for a connection is inferred. The ordered payment query already
  has an index on `(auth_workspace_id, booking_day)` (`prisma/schema.prisma`); the number of payments
  was not counted. An `EXPLAIN ANALYZE` on a restored copy settles both.
- **S2. The sidebar numbers ran the dashboard's work on every click** (verified: request capture
  showed one server action on every non-dashboard page, and `AppStoreProvider` called `getNavCounts`,
  which runs `loadReviewQueue` and `loadMealRecords`, on every pathname change; its duration in the
  browser was 1.6 to 3.1 s). Server actions of a page run one at a time, so a save made right after a
  click waited for it (inferred from how Next.js queues actions; not timed). **Fixed**, see below.
- **S3. The receipts page loads its rows after the page, 200 at a time, one after another**
  (verified: `ReceiptsStore.readPages`, `PAGE_SIZE = 200`, through server actions; on the receipts
  page six actions ran in sequence after the document, the first taking 1.05 s). With 477 receipts
  in the selected year that is three pages in sequence, each a server action in the same single
  queue as the year counts and the meal count.
- **S4. Finance renders the data of every tab at once** (verified: 1,227 of its 1,258 KB are
  serialized data, 31 KB markup; `FinancePage` sends `getStatement` for the whole year to the client).
  It also has no `measurePage` around it, so its server time is in no log.
- **S5. Each page load starts 16 prefetches of the sidebar's links** (verified: 8 route-tree
  requests and 8 page requests per load, every page). Each is a dynamic request through the
  middleware and the session check; each answers about 1 KB, stopping at the loading boundary. Their
  server cost is inferred (none crosses the 700 ms log threshold); under load they took 0.9 to 1.1 s
  each, so they compete with the page's own work.

### Frontend

- **F1. The spending page's closed payments table: 20,401 elements** (verified in production; the
  page has 28,435). A closed `<details>` is still created, laid out and styled. **Fixed.**
- **F2. "Unklar" lists all 345 counterparties of the year at once** (6,600 elements, each with a
  select of every category). **Fixed** (50 at a time).
- **F3. The spending page sends its data twice in effect**: 1,573 KB of markup and 1,813 KB of
  serialized props (verified). The props carry every payment of the period because the client
  computes the charts and the table from them.
- **F4. No page is kept between visits.** Every page is `force-dynamic` and nothing calls
  `revalidatePath`, so turning on the router's keep-time for dynamic pages
  (`experimental.staleTimes.dynamic`) would show stale numbers after a write. Read in the code;
  that is why it was not switched on here.
- **F5. One endless animation on every page** (`aurora-drift` on the body background; verified). It
  stops under "reduce motion" (read in `globals.css`). With 250 to 4,300 elements on most pages its
  cost is small; it was not isolated.
- **F6. The receipts page jumps when the table arrives** (CLS 0.29 to 0.56, verified, sources the
  filter row and the table container). Not fixed: the cause is in how the table's container is
  sized before its rows come, which needs the data-table package.
- **F7. Mixed languages in the receipts page**: "Table", "Board", "Calendar", "By Vendor", "list",
  "Search…", "+ Add filter", "Expand all", "Processed", "Pending" next to German text (verified on
  the screenshots of desktop and phone). Partly view names stored in the data, partly defaults of
  `@marlinjai/data-table-react`.

### PWA

- **P1. Installable, and the service worker is registered** (verified: Chrome reports no
  installability error and no manifest error; the worker is active with scope `/`; app id
  `https://receipts.lumitra.co/app`). Read in `public/sw.js`, not exercised: it caches only
  `offline.html`, answers the share target and shows pushes, by design, because the worker removed
  in March 2026 cached scripts and broke deployments.
- **P2. The manifest was out of date** (verified): name "Receipt OCR" and an OCR description, SVG
  icons only, no `id`, no language, no shortcuts. iOS takes no SVG for the home screen icon
  (`apple-touch-icon`) and shows a screenshot of the page instead (inferred from Apple's
  documentation, not tried on a device). **Fixed.**
- **P3. The root layout said `lang="en"` for German pages,** so screen readers read German with
  English rules and Chrome offers to translate (verified in the code). **Fixed;** the English landing
  page says `lang="en"` on its own.
- **P5. The page blocks pinch zoom** (`maximumScale: 1`, verified in the code), which fails people who
  need larger text (WCAG 1.4.4, the success criterion on resizing text). Not changed here: allowing it
  needs every field on a touch screen at 16 px or more, or iOS zooms into a field and stays zoomed,
  and that rule resizes every input and select of the data table on phones. It is proven on phone
  screenshots before it ships (section 4).
- **P4. No offline view of the app's data.** Offline, a navigation shows `offline.html`, where a photo
  can still be queued. Whether the app should show the last seen receipts offline is a product
  question (see "Questions for Marlin").

## Fixed with this plan (branch `perf/receipts-perf-pwa-ux-review`, local, not deployed)

A push to `main` deploys to production by itself (`.github/workflows/deploy.yml`), so no pull
request was opened. The "after" figures are from tests on fixtures or follow by construction; the
production effect is measured after a deploy Marlin approves.

| What | Before (production) | After |
|---|---|---|
| Sidebar numbers per click | 1 server action of 1.2 to 3 s on every page change | none while the last numbers are under a minute old; the receipts page hands its own over when it closes (test: 5 clicks, 1 call) |
| Spending, closed payments table | 20,401 elements built on every load | 0 until opened (test: 120 payments, 0 rows closed, 120 open) |
| Spending, "Unklar" | 345 rows at once | 50, and 50 more per press (test) |
| Manifest | "Receipt OCR", SVG icons only | "Lumitra Receipts", PNG 192, 512 and maskable 512, `id` `/app` (unchanged identity), German, 4 shortcuts (test checks sizes and files) |
| iOS home screen icon | none usable (SVG) | 180 px PNG |
| Page language | `en` | `de` (the English landing page `en`); titles read "Ausgaben · Lumitra Receipts" |
| Upload page heading | "Receipt OCR" | "Lumitra Receipts" |

- **Sidebar numbers** (`src/stores/provider.tsx`, `src/stores/AppStore.ts`): a page asks only when
  the last known numbers are older than a minute (`NAV_COUNTS_FRESH_MS`). The receipts page counts
  both in its own store and hands them over when it closes (`countsKnownAt`); the meals page hands
  over its meal number, which alone does not make the pair fresh. A
  failed answer makes the next page ask again, an answer that arrives after the next click still
  shows unless the receipts page handed over newer numbers in between, a receipt saved or discarded
  on the upload page has the next page ask (`countsChanged`), also when it happens while an ask is
  on its way or when that ask fails, and a meal write that ends on another page still asks at once.
  Changes and hand-overs are ordered by counters, not by the clock, so two events in the same
  millisecond cannot be mistaken for each other (found by the hermes test run and the review).
- **`LazyDetails`** (`src/components/ui/LazyDetails.tsx`): a disclosure whose content is built on
  the first open and kept after it. Used for the spending page's payments table.

Decided, say so if you disagree:

- *A minute of freshness for the sidebar numbers.* A receipt reviewed on the finance or spending
  page can therefore show in the sidebar up to a minute late. The pages that change these numbers
  most (receipts, meals) keep them exact, because their stores count them live.
- *"Lumitra Receipts" and "Receipts" as the installed name.* It is the name in `AGENTS.md` and the
  README; the old one described a feature that is no longer the point of the app. The amber theme
  colour stays; the Lumitra mint is a design decision, not a fix.
- *The payments table is not searchable with the browser's find until opened once.* The price of
  not building 20,000 elements nobody sees.
- *No caching added to the service worker,* because its stated rule (never cache pages or `/_next/`)
  comes from a real incident. Whether to change that is asked below.

## What remains, in order

Effort: S under an hour, M about half a day, L more.

### 1. Make the payments read cheap (highest value, M to L)

- [ ] **Find where `payments.read` spends its time and cut it** (S1). First an `EXPLAIN ANALYZE` of
  the six queries on a restored copy (no production load), with the payment count, then the fix the
  plan shows (an index that also covers the `created_at` tie-break, selecting only the columns the
  rows use, the links query apart, or keeping the result per company until a write). A target of
  under 200 ms is a guess until that plan exists. Every page with a log line gains by the same amount.
- [ ] **Why the dashboard is slower than after the October fix** (verified regression, warm against
  warm: 1.0 to 1.1 s then, 1.7 to 1.9 s now). Inferred cause: more payments and the review list now reading them
  (`review.payments`). The step above is the first answer; compare the log after it.
- [ ] **Measure finance** (S): wrap `FinancePage` in `measurePage` and `withSharedReads` like the
  other pages, so its server time is logged and its reads are shared.

### 2. Shorten what a click waits for (M)

- [ ] **Load the receipts page's rows in one request, not in pages of 200 one after another** (S3),
  or start the first page on the server with the page itself, so the table is there with the page.
  This also removes the jump (F6) if the first rows arrive with the document.
- [ ] **Finance: send the data of the open tab only** (S4), the rest when its tab opens.
- [ ] **Spending: compute the charts and the payments table on the server, or send the table's rows
  only on opening** (F3): 1.8 MB of serialized props.
- [ ] **Keep pages between visits** (F4): make every write action say what it changed
  (`revalidatePath` or tags), then switch on the router's keep-time for dynamic pages. Without the
  first, the second shows stale figures, which is worse than slow.
- [ ] **Fewer prefetches** (S5): prefetch on hover or on entering the viewport instead of all 16 on
  every load, once the server cost of a prefetch is measured.

### 3. Navigation and interface (S to M)

- [ ] **One language on the receipts page** (F7): German labels from `@marlinjai/data-table-react`
  (its locale) and the stored view names renamed.
- [ ] **A loading state shaped like the page it stands for**: today every page shows the same
  centred "Wird geladen…" box; a skeleton in the page's layout makes the 1 to 4 s feel shorter and
  removes the jump when the content arrives.
- [ ] **Phone run with a throttled processor** (see "Not measured") before deciding on more
  frontend work: the complaint is about the installed app on the phone.

### 4. PWA

- [ ] **Allow pinch zoom, proven first** (P5): fields on touch screens at 16 px or more, compared on
  phone screenshots with touch emulation (the receipts table's search, filters and selects
  included), then `maximumScale` removed.
- [ ] **Try the installed app on an iPhone and an Android phone after the deploy**: icon, name,
  shortcuts (Android), share target (Android), offline page, a push.
- [ ] **The remaining "Receipt OCR" texts**: the English landing page and the push fallback title in
  `public/sw.js` (changing the worker file updates every installed copy, so it goes with the next
  worker change).

## Not measured

- The installed app on a phone, and a phone viewport with a throttled processor. The session's
  machine was overloaded; such numbers would not have been comparable.
- The server cost of one prefetch (below the log threshold).
- How long a save waits behind a running server action (inferred from how Next.js queues them).
- Which script files are largest and what is in them. Only the totals were measured (553 to 1,076
  KB per page, 176 to 327 KB on the wire); a bundle analysis of a production build is open.

## Questions for Marlin

1. **Offline:** should the installed app show the last seen receipts and figures without a
   connection? It would need the service worker to keep pages or data, which its current rule
   forbids for a good reason (a stale app after a deploy). Today offline means: the capture queue
   and nothing else. Recommendation: keep it so until the payments read is fixed; that is where the
   felt slowness comes from, not from the network.
2. **Theme colour of the installed app:** amber as in the app's accent, or the Lumitra mint?

## Tests

- `src/stores/__tests__/provider.test.tsx`: one ask over five clicks while fresh and a new one after
  a minute; a late answer still shows; a failed answer and a thrown one make the next page ask; the
  receipts page's numbers are handed over without asking.
- `src/components/ui/__tests__/LazyDetails.test.tsx`: nothing built while closed, built on open and
  kept after closing, a closing toggle builds nothing.
- `src/app/app/spending/SpendingClient.test.tsx`: 120 payments build no table row while closed and
  120 on opening; "Unklar" shows 50, 100, 120; the existing tests open the table before reading it.
- `src/lib/pwa/__tests__/manifest.test.ts`: `id`, name, language, PNG icons of the sizes they say,
  the iOS icon named in the layout, `lang="de"`, shortcuts inside the app, the share target the
  worker answers.
- `src/components/nav/__tests__/AppSidebar.test.tsx`: the sidebar asks again only once its numbers
  are a minute old, and keeps the last ones when that fails.
- `src/stores/__tests__/provider.test.tsx` also: an answer asked before the receipts page handed
  over its numbers does not overwrite them; a receipt saved on the upload page has the next page ask,
  once.
