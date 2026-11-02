---
title: One client state for the receipts app
summary: Every page keeps its own copy of the server's data in component state, so a change on one page cannot reach anything else on screen, and numbers derived from it go stale. This plan proposes MobX stores per domain, with derived numbers as computed values and observers that redraw only what changed, moved over one page at a time. The owner approved it on 2026-11-01 and asked for it to run autonomously.
type: plan
status: in-progress
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
3. **Rows redraw by record:** `memo` on an immutable record, or `observer` where a row reads the
   store itself, so reclassifying one meal redraws that row and its badge, not the page.
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

## Reality

### Slice 1, meals and the navigation (2026-11-01)

- `src/stores`: `AppStore`, one per company under the layout (the layout keys the provider by
  company), and `MealsStore`, one per visit of the page, created from what the server sent. The
  page opens its store on the `AppStore` and closes it again, so no global object exists and a
  server render reads a plain store.
- The navigation's numbers are `AppStore.counts`, a structural `computed`: the same numbers mean
  no redraw. While the meals page is open its number is `queue.length`, so a late server answer
  cannot overwrite it; on closing, the last number stays until the server's next answer.
- `MealsStore` holds records by id in a shallow map, replaced whole, never changed in place. That
  is what lets a row tell by identity whether it must redraw (`QueueRow`, a test proves the other
  rows stay untouched).
- `useReportNavCounts` stays for the dashboard until its slice, and goes then.
- `tab` and "unsaved form" stay component state: they belong to one view on screen, not to the
  domain. Rule for the following slices: data from the server goes into a store, what only one
  view cares about stays in that view.

### Slice 2, the receipt checks (2026-11-01)

- `ChecksStore`, one per visit, opened on the `AppStore` like `MealsStore` and thrown away with the
  company (`page.tsx` keys the panel by company). It holds open and answered payments in one map by
  id, a check replaced whole, plus the notifications and the settings. The open list, the years, the
  proposal, certain and backlog counts and the lost/answered split are computed, so `certain` left
  `ChecksView`: the server no longer states what follows from the list. Year, "mit Vorschlag", limits,
  the picker's input and open forms stay in the view: they belong to one view on screen.
- **One answer, one payment.** Confirm, no receipt, take back, link by hand, take over, dismiss mail
  and mark read return what changed (`CheckChange`: state, the receipt taken, the messages settled, a
  server time) instead of a whole view. Check now, link certain, close backlog, settings and push still
  return everything. Cost on the server: an answer's state is worked out for that payment alone
  (`paymentState`, `onePayment`), and its answer no longer loads the notifications, the mailbox status and
  the device count. Confirm, link and take back still read what a state is worked out from (all
  payments for the links, all receipts), once where it was twice, because whether a receipt is proposed
  depends on them. "No receipt" and a link return their state without a further read. Take back
  now always reads, to say what the payment's state is; it used to read only when nothing was deleted.
- **What is on screen is worked out, not patched.** The store keeps what the server last said and a
  pile of writes on their way, and draws the one over the other. A snapshot would be wrong here: with
  two links out and a third payment proposed both receipts, rolling one back must return one receipt, not
  the state from before either. Refusing just takes the write off the pile. A link holds its receipt
  back from every other proposal meanwhile, and a payment left with none falls to its mails (`proposed`
  now carries them, `withoutReceipt`) or to missing, as `loopState` would say.
- **Late answers.** Writes are numbered per store: an answer to a write older than the newest one
  answered for that payment changes nothing about it, though its receipt still counts as linked. A read
  says when it started (`readAt`, for a page render the start of its shared reads, as another part of
  the page may have begun them earlier), a change when it was made (`at`): a read older than the last is
  dropped, and what was confirmed after a read started is laid over it again, so a slow `router.refresh`
  brings nothing back. Both times come from the same server; with several instances a change within
  the clock's difference could show wrongly until the next read.
- **Refreshing the page: only on leaving.** The overview, the budgets and "Was gekauft" are other tabs,
  only the open tab's panel is on the page, and a tab is read from the server when it opens. So nothing
  beside the checks can go stale, and `router.refresh()` after every answer would have sent all
  payments back each time, which is what this slice removes. A change that touched payments owes the page
  one read when the panel closes: for what the next tab's read could not know yet, and for the back
  button, which the router serves from its cache. It fires wherever the person lands, so switching tabs
  after an answer costs two reads, once. An answer arriving after that reads at once. Marking
  read and the settings owe nothing. The count on the tab is the one number that is on screen: it reads
  the store (`OpenChecksCount`), on its own, so an answer does not redraw the page.
- **What a link cannot know on the client.** A link teaches that a counterparty stands for a vendor
  (`vendorAliases`), which can give other payments new proposals. They appear with the next read, as
  they would have after a whole view only because that view was sent. A "no receipt" given in a second
  tab to a payment that got a link in the first shows as answered until the next read.
- **The focus.** Every answer moves it to the list's heading at once, as the row goes with its buttons.
- **Take over.** The upload can take seconds and fail on its own, and its receipt is not known before it
  ends, so the row stays and shows what it does. What applies at once is the link that follows. The picker
  moved into `PickReceipt`, which reads `dataVersion` itself, so closed rows do not redraw on it.
- `OpenCheck` is memoized by its check, its actions come through a ref as in `QueueRow`, and other rows
  stay usable while an answer is out: only bulk actions lock them.
- **What outlives the panel.** A person can leave while an answer is out, so the pile of writes and the
  refusals live in a `ChecksOutbox` on the `AppStore`, not in the `ChecksStore`. A new store starts with the
  writes still out, so coming back shows the payment as answered and offers no second click, and a write begun
  on the last visit ends on the store open now. While writes are out, closing the page asks first
  (`beforeunload`, in the provider).
- **A refusal always reaches the person.** They are kept per payment, plus one per message and one per page
  action, and leave only by acting on that thing again or by closing them. A page read does not touch them. A
  refusal stands at its row, and a row with one stays in the list whatever the filter says. With no row to
  stand at, because the panel closed or a whole read took the payment away, `CheckRefusals` in the shell says it
  through the dock, naming the payment. That includes "receipt made, not linked". A company switch throws the
  `AppStore` away; what it still has to say goes to the `RefusalDesk` (see the meals below).
- A refused "no receipt" brings its row back fresh, without the reason typed: the row left the list, and
  with it its form. Refusals there are rare (the button needs a reason, the rest is another tab).

### The meals write at once (2026-11-02)

- "Keine Bewirtung", take back and delete apply in `MealsStore` on the click and are sent after that, as the
  checks do: the store keeps what the server last said (`known`) and a pile of writes, and draws the one over
  the other. A refusal takes the write off the pile, so the receipt comes back as it is by now, in its place.
  Other rows stay usable while an answer is out (the one-at-a-time lock of `useReceiptActions` is gone), the
  delete keeps its question, and a dialog closes on the confirmation, not on the answer.
- **Repeated, not generalized.** `MealsOutbox` has the shape of `ChecksOutbox` in about 60 lines. The checks'
  outbox is tied to a payment, to a receipt held back from other proposals and to `CheckChange`, and a meal
  write is a batch whose answer speaks per receipt. Sharing them would mean opening proven code to save those
  lines. What is shared is the place in the shell: `CheckRefusals` became `Refusals` and shows both.
- **Per receipt, not per batch.** A batch's answer says what it did for each receipt: done takes the server's
  record, `not_found` takes the receipt away, a receipt left alone falls back. One notice reports the batch, as
  before. A failure is a refusal, and goes to the shell whether or not the page is open, because meal rows have
  no place for a message. On the page it reads as it always did; away from it, it names the receipt. It leaves by
  being closed or by acting on one of its receipts again. Plain outcomes stay in the tab and leave with it.
- **Late answers go by the server's time.** Numbering writes as the checks do would not do here: a form save and
  a turned receipt change the same record and are no writes on the pile. So every answer about a receipt says when
  it was made (`at`, on batch results, `saveMeal` and `saveReceiptRotation`), and the outbox keeps the newest per
  receipt: an older answer changes nothing, whichever kind it is. A page read says when it started (`readAt`), and
  what was confirmed from then on is laid over it, so the back button, which the router serves from its cache,
  brings nothing back. The kept records are one per receipt, for as long as the company is open. Both times come
  from the same server; with several instances a change within the clock's difference could show wrongly until
  the next read.
- **Leaving.** The number in the navigation is `queue.length`, so it moves on the click. A write ending after the
  page closed has the navigation ask the server again, because the number left behind took it for done. While a
  write is out, closing the page asks first, as for the checks.
- The focus goes to the page's heading when a row leaves with its button, and to the notice when the answer comes,
  unless the person has moved on by then: a notice takes the focus only when nothing holds it, and is announced either
  way. Rows stay usable while an answer is out, so it can arrive in the middle of typing.
- **A form save reaches the page on screen too**, like a list action: it can answer after leaving and returning.
- **A company switch.** The `AppStore` is still thrown away, so nothing of one company stays on screen in another, but a
  refusal must reach the person who believes the change went through. `RefusalDesk`, above the provider the company keys,
  takes what is left to say and what arrives later, for checks and meals alike. It always says the company's name, so it
  can never read as the one on screen's, also after coming back to that company.
- **On the dashboard** the number is the `ReceiptsStore`'s, so a meal write ending there has that store ask again.
### Slice 3, receipts on the dashboard (2026-11-02)

Measured before building, with the real `TableView` under a counting cell, 267 rows by 20 columns:

- **A redraw.** One record changing draws 5,340 cells, and so does a reload that changes nothing.
  The cause is in the package: `renderDataRow` is a closure over the table's state, so no row can
  skip a redraw, and every load hands in new objects anyway.
- **A reload.** Every action reloads all pages (one request per 200 rows) and the columns. The
  list falls back to its first 200 rows and grows again while the pages arrive.
- **Three holders of one thing.** The package's `useRows` holds the rows and races itself (a late
  page lands on a fresh list), which is the only reason `use-complete-rows.ts` exists, with its
  queue, its dedupe and its repairs. The years the list asks for sit in a module-level variable
  (`year-scope.ts`), because the package builds its own query. `placedOrder` and the review list
  are page state, and the navigation's numbers are reported by hand.

Decided:

- **`ReceiptsStore`, one per visit, owns what comes from the server and what is asked of it:** the
  rows by id, loading and failure, the query (years, filters, sorts), `placedOrder`, the year
  counts, the review list and the open meal count. Computed: `rows`, `receipts`, `groups`,
  `totalReceipts`, `reviewCount`. With one loader there is one list: a load replaced by a newer one
  drops its late answers, so the queue and `year-scope.ts`'s variable go, and with them
  `use-complete-rows.ts`. A row twice or a count that does not add up is still read again, at most
  twice, because a receipt added while pages arrive moves the rest by one.
- **The table takes rows from outside without a package change.** `TableView`, `BoardView` and
  `CalendarView` already take `rows` as a prop; only `useTable` holds them. The provider's existing
  `initialData` with an empty list keeps `useRows` from loading, and `useTable` stays for the
  table, columns, select options and views. Two of its functions read its own rows and would go
  wrong on an empty list (`uploadFile` would overwrite a cell's files, `deleteFile` would do
  nothing), so the store does those two. An upload stores its reference before it writes the
  cell, the other way round from the package: the adapter ignores a file cell and answers with its
  file table, so only this order shows the upload at once, with the server's id to delete it by.
  A `rows` option on `useTable` would be the nicer interface, but no page needs it now.
- **A reload keeps the objects of rows that did not change,** so the page only redraws what
  changed. It swaps the list when all pages are in, so a reload no longer shrinks the table. A
  change of years, filters or sorts still fills the list page by page, because waiting for
  thousands of rows on an empty table would be worse.
- **Rows redraw by record** takes one package change, internal and without a new prop: a memoized
  row in `TableView`, published as version 0.12.0, which this app now depends on.
- **Stays with the page, because only that view cares:** the search term and its hits, selection,
  the focused row, the open panels, the delete question, notices, `working`, the review list's
  error text, and the way a linked receipt is opened.
- **Numbers of the navigation:** `AppStore.counts` reads `reviewCount` and the open meal count while
  the page is open. The review list and the meal queue need every year and every meal, which the
  page does not load, so neither can be computed from its rows: the review list stays the
  server's, and the meal count is asked again a moment after a row changed, together with the year
  chips. That closes the same stale number on this page that slice 1 closed on the meals page.
  `useReportNavCounts`, `AppStore.report` and `stopReporting` go.
- **Not optimistic yet.** Cells keep waiting for the server's answer, as they do today and as the
  meals do: rule 4 of the proposal needs server actions that return only what changed, which the
  group and review actions do not. A row added or saved while a load is on its way is kept over
  what that load read, also when it did not read the row, so a late read never overwrites a newer
  write.
- **An export is never partial.** It goes out only when `complete` says the whole list is here:
  nothing loading, nothing failed, and the rows add up to the server's count. Otherwise both
  buttons say why, in the page.

Result, measured the same way:

- One record changing draws its 20 cells instead of 5,340, and a reload that changes nothing draws
  none (test `row-redraw.test.tsx` in the package; here, a saved cell changes that row's part of
  the page and no other, on the published package).
- The phone list redraws by card (`ReceiptPhoneList.redraw.test.tsx`), the review list and the
  open group read the store themselves.
- `use-complete-rows.ts`, `year-scope.ts`, `useReportNavCounts` and `AppStore.report` are gone. A
  reload no longer asks for the columns, because no row action adds one; it still asks for the
  select options, because a receipt read again can name a new one.
- `DashboardContent` stays one observer: with rows that redraw by record, what is left of a change
  is a walk over the row list, so splitting it further would be for its own sake.
- In development React runs effects twice, so `useRows` reads one page into its unused list.
  It is not in a production build and nothing reads that list.
### Slice 4, the finance tabs (2026-11-01)

What is there, read from the code before moving anything. The about 126 `useState` calls are nearly all form
fields, and they stay. There is exactly one copy of the year: `view`, a whole `StatementView`, in `FinanceClient`;
every tab reads it through a prop and every write answers with a new one. So a tab cannot be moved on its own:
holding that `view` in a store for some tabs and in `useState` for others would be the two sources this plan
forbids. The statement moves first, for all tabs at once, and the tabs follow with what is theirs.

| Tab | Server data it reads | Worked out from it today | Stays in the view |
|---|---|---|---|
| Kopf, Zähler | `view` | `openQueue`, `overdue`, `openAssets`, `estimated`, `blockedBySetting`, `waitingCounts`, `groupCount`, tiles | `group`, `chosen`, `firstTab`, `notice`, `error`, `pending` |
| Offen | `items`, `formLines`, `assetLimits`, `revenue.overdue` | `queue`, `selected` | `selectedId`, `editingId`, `splittingId`, `assetFromRow`, `TreatmentForm`, `LinesForm` fields |
| Zahlungen klären, Zahlungen, Konten | `payments`, `BankView` (own copy in `useBankFeed`), `SharingView` (own copy, `view` and `shown`, in `AccountSharing`) | `unambiguousPairs`, `listEmpty`, `selectedAccount` | `lastImport`, form fields, `manualFor`, `browsing`, the bank's message per account, search results |
| EÜR | `lines`, `items`, `assets`, `formSources` | `itemsById`, `assetsById`, parts per line | `openLine` |
| Einnahmen | `revenue`, `forecast`, `limits` | nothing beyond the labels | `editing`, the invoice form, `expectation` as typed |
| Anlagen | `assets`, `items`, `assetLimits` | `candidateReceipts` | `editing`, `disposing`, `expanded`, the forms |
| Umsatzsteuer | `vat`, `statusChanges` | nothing beyond the labels | the forms, seeded from the view when the tab opens |
| Einkommensteuer | `incomeTax` | nothing beyond the labels | `showProjected`, the forms, `months` and `filedOn` as typed |
| Lieferanten | `vendorRules`, `reverseChargeVendors` | nothing | nothing |
| Eigene Namen | `OwnNamesView` (own copy in `FinanceClient`) | nothing | `namesError`, `namesNotice` |

What moves: the statement, the bank connections, the sharing and the own names into one `FinanceStore`, and
everything in the third column that is worked out in `FinanceClient` into its `computed`s. Nothing else: no form
field, no open row, no message.

What does not move, on purpose: **no figure is worked out on the client, and finance does not write
optimistically.** A tax number, a total and a form line come from the server's calculation, and one answer can
change any of them, so a write here stays what it is, a wait for the whole view. The rule of this plan that numbers
are `computed` applies to what the client counts, such as the tabs' badges, not to the tax calculation.

Proof that no figure changes: `FinanceClient.figures.test.tsx` renders a realistic year (`__tests__/statement-fixture.ts`)
tab by tab and compares the whole markup with files written by the code from before the move, in the commit that
adds them, before any store exists.

- **The statement and the payment tabs moved first (`FinanceStore`).** One store per visit and per year, held by the
  page, not on the `AppStore`: nothing outside finance reads it, and the layout's key already gives each company its
  own. A year is a new store, so an answer for the year just left lands on a store nobody reads; before this it
  would have shown the old year under the new one. Every tab reads `store.statement`, so Einnahmen, Anlagen,
  Umsatzsteuer, Einkommensteuer and Lieferanten have nothing left to move: they held no copy of their own.
  `useBankFeed` and `AccountSharing` lost their copies, and take what they show as props.
- **Late answers.** A statement says when its read began (`readAt`), and a statement older than the one on screen
  changes nothing: a write and a bank sync can overlap. The same year sent again by the server takes its place too;
  before, the page ignored it.
- **By record.** A write still answers with the whole year. `reuse` keeps every part of the new statement that did
  not change as the old object, so identity tells a row what changed; it finds records in a list by id, so a list
  that lost an entry keeps the others.

