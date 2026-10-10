# Roadmap

## Planned

- [x] Company erasure hands over an export first: the company's register and contacts go into a
  zip (GET /api/export/company), and printed guest names are removed at once when an export was
  taken, otherwise held for ten years (German tax law, the Abgabenordnung, AO) and removed by the
  retention purge. Built in this change, 2026-10-09.
- [ ] Enable the retention purge of held guest copies only after recorded legal confirmation
  of the retention policy. The implementation explicitly requires that review before go-live.
  The production `RETENTION_PURGE_SECRET` was generated securely in Infisical on 2026-10-09;
  no schedule was enabled. The backup and scratch restoration prerequisite is complete.
  Once the legal policy is confirmed, run the signed purge verification and enable its daily
  Coolify schedule. Preparation: `docs/operations/retention-purge.md`. (2026-10-09)

<!-- Decided features, ready to be worked on -->

- [ ] Finance and tax dashboard, stage 2 (scenario engine): "what if I buy X on date
  Z at share S" and "what if revenue is R", computed by the same tax module as the
  dashboard, saved as inputs and never as results. After stage 1. Plan:
  `docs/plans/2026-10-07-finance-tax-dashboard-and-advisory.md`. (2026-10-07)
- [ ] Finance and tax dashboard, stage 3 (advisory layer): deterministic hints that
  each show inputs, rule, source and euro effect, the legal form comparison (sole
  proprietor against a company with limited liability or a partnership) with a
  hand-off to a tax advisor, and last an optional language model that may only quote
  computed figures. Operator only until a lawyer's opinion on the tax advisory act
  and public bank data access exist. After stage 2. Plan:
  `docs/plans/2026-10-07-finance-tax-dashboard-and-advisory.md`. (2026-10-07)

- [x] Extraction defects found in the first live upload (2026-10-08, a 21-page scan of
  restaurant receipts uploaded with "One receipt per page"). Done 2026-10-10. Root cause
  behind four of the seven: the language-model classifier never ran in production (no
  Anthropic key is set there, the call threw, the error was swallowed), so every receipt
  was filed by pattern matching alone. It now runs through the OpenRouter key production
  has, and a missing or failed classification is recorded on the receipt. (1) and (2):
  total, net and tax come from the tax groups the receipt prints and are confirmed by its
  own arithmetic (`src/lib/extraction/amounts.ts`); a receipt number, a date or a rate is
  no longer an amount; a printed tip is split off the total; a total that only a label
  vouches for is put up for a look; nothing is guessed from the largest number. (3) a page
  nothing could be read from is named "Nicht lesbar: <file>" and stands in the new review
  list. (4) a table, a waiter, a tip line or the printed hospitality form make a restaurant
  receipt (`meal-evidence.ts`). (5) the vendor reader skips slogans, item lines and misread
  logos and joins a name set in several lines (`vendor.ts`). (6) look-alike receipts are
  found on read from the stored receipts and the decision "keep both" is stored (table
  `receipt_reviews`, migration 0014), so the question survives leaving the upload page.
  (7) could not be reproduced: the year list was already built from all meal receipts,
  complete or not; it is now pinned by tests, the current year is always offered, and
  meals without a date (which belong to no year) are counted on the register tab.
  Checked against all 21 receipts of that upload, restored from the verified backup into
  a local database. (2026-10-08)
- [x] Receipts stored before 2026-10-10 kept the readings of the old reader (for example
  a total that includes the tip, or a slogan as the vendor). Done 2026-10-10: the review
  list reads the stored text again with the current reader (no model is asked, the
  result is the same every time) and offers what differs as "stored / newly read", field
  by field (`src/lib/review/reading.ts`). Nothing is written until the offer is taken;
  "Geprüft, stimmt so" keeps what is stored and ends the offer. Only what the reader
  stands behind is offered, and a field is never offered to be emptied. On the restored
  copy of the live data 13 of 24 receipts get an offer. (2026-10-10)
- [ ] Direct model access with web search for the classifier is optional and not set up:
  it needs an Anthropic key in the receipts production settings (`ANTHROPIC_API_KEY`, a
  credential only the owner can issue). Without it the classifier decides from the
  receipt text alone through OpenRouter, which is what runs today. (2026-10-10)
- [x] Deleting a receipt in the dashboard table left its stored file behind. Done
  2026-10-10, decided by the owner's standing goal: the dashboard deletes for good, the
  same way the meals page does. `deleteRow` and `bulkDeleteRows` in
  `src/app/app/dashboard/actions.ts` go through `deleteReceiptRows` (stored file first,
  row second, a file another receipt still shows is kept, a receipt whose file cannot be
  deleted stays complete and is reported). The dashboard now asks before deleting, in
  the page: before, Backspace on a selection deleted at once. (2026-10-08)
- [x] Production database backups verified: six-hourly Coolify dumps, 28 copies
  locally for seven days, native European Union R2 copies for 30 days, and an hourly
  additional copy to Hermes with 30-day retention.
  A scheduled dump restored in an isolated PostgreSQL container with matching counts
  for all 28 public tables (639 rows), logical column definitions, constraints and
  indexes, including a fresh copy downloaded from R2. Production health stayed green.
  No new fixed hosting cost; normal existing object-storage usage applies.
  Plan: `docs/plans/2026-10-09-production-backups.md`.
  Recovery: `docs/operations/production-recovery.md`. (2026-10-09)
- [ ] Three defects in the shared table adapter (`@marlinjai/data-table-adapter-prisma`
  0.2.1) that this app now works around and that belong fixed there: (1) nothing stops
  two columns of one table from carrying the same name, so a check-then-create race
  doubles a column (here: a per-workspace lock in `ensureReceiptsTable`; there: a unique
  index on table and name, or a lock in `createColumn`); (2) `getRow` reads with a
  prepared `SELECT *` and swallows every error, so after any column was added or
  dropped Postgres answers "cached plan must not change result type" and the adapter
  reports "Row not found" (here: `statement_cache_size=0` in `src/lib/prisma-url.ts`;
  there: list the columns, and let the error through); (3) `updateRow` silently skips a
  cell whose column it does not know and still reports success. (2026-10-09)
- [ ] Migrate the `/api/*` `SERVICE_TOKEN` machine path to tenant-scoped auth-brain
  API keys. Deferred out of the app-grant door flip (that slice left the shared
  `SERVICE_TOKEN` bearer unchanged); machine callers should carry a
  tenant-scoped key so their access is entitlement-checked like browser sessions. (2026-09-10)
- [x] Deploy Docs GitHub Actions workflow failed on every run from at least 2026-08-03.
  Resolved, this line was stale: the Infisical credentials were provisioned on the
  repository and the workflow was repaired in pull request 27 (action pin, project slug,
  scoped path). Last failure 2026-09-14; every run since has succeeded, latest run
  37986504043 on commit 565e4e1 (2026-10-09), and https://docs.receipts.lumitra.co answers
  200 (checked 2026-10-10). The standalone docs site stays. (2026-09-10)
- [ ] The dashboard workspace dropdown still lists a drained legacy workspace
  labeled "Lola Stories" whose data was migrated away (leftover from the PR #18
  app-grant gating cleanup). The ambiguous-label half of this is fixed (adopting
  the shared `WorkspaceSwitcher` from `auth-brain-nextjs` 0.4.1 now labels a
  single-workspace company by its company name instead of a bare "Main"); what
  remains is hiding or deleting the drained legacy workspace membership, which is
  a production data change/audit in the auth-brain multi-tenant service, not a
  code fix in this repo. Needs Marlin or a data audit before touching it. (2026-09-10)

- [x] Contact screen, wave 3: the Kontakte tab manages organizations with address, legal form and
  VAT ID, links people to organizations, merges duplicates, assigns customer numbers and exports one
  contact. Completed 2026-10-10 on `@marlinjai/contacts-core` 0.2.0: the company defines its own
  fields (text, number, date, yes or no, one or several options, link), every contact carries a
  value for each and a preferred contact method, and one contact can be erased. Its printed names
  on meals follow the rule of the company erasure (removed when an export exists, otherwise held).
  The tab badge counts persons and organizations. Plan:
  `docs/plans/2026-10-09-contact-screen.md`. (2026-10-09)
- [x] Contact screen repairs, found in the live check of 2026-10-10: (1) the guest list, the
  directory and the tab badge now follow each other without a page reload, in both directions
  (a change in one list reloads the other; an erase or a merge also reloads the meals);
  (2) a person can be created in the directory with its details, custom field values and
  preferred contact method, as an organization can; (3) the export rule was wrong for an old
  export: printed guest names are now removed on an erasure only when the register is
  identical to the company's newest export (`company_exports.register_sha256`, compared by
  hash), and held in every other case, including an export taken before a later meal or
  correction. The export now also lists every printed guest name, so names on incomplete
  meals are part of it. Done 2026-10-10. (2026-10-10)
- [ ] Business data belongs under the company Whiz-Art Media, which has the receipts grant, a
  workspace and its imported customers, while the business meal register and its guests still sit
  under the company marlinjai. Moving the register is a production data move: write the plan first,
  and run it only against a verified backup. (2026-10-10)

## In Progress

<!-- Currently being implemented -->

- [x] Shared contact list, wave 2: the business-meal guests moved to the suite's shared
  contacts database (company-scoped, behind the `CONTACTS_STORE=shared` switch, default
  off), with a merge-aware data move that Marlin reviews before anything is dropped. Done
  2026-10-09: the switch is on in production. Waves 3 to 5 are open in the knowledge-base
  roadmap. Plan: `docs/plans/2026-10-09-shared-contacts-wave2.md`. (2026-10-09)
- [ ] Finance and tax dashboard, stage 1 (data foundation and live dashboard). Built:
  slice 1 (tax module with rule sets for 2025 and 2026, shares for several purposes
  per receipt, vendor rules, the queue of open checks, the income-surplus statement
  at `/app/finance`), the asset register of slice 2, slice 4 (issued invoices,
  revenue by payment day, profit or loss, forecast of the small-business limits) and
  slice 5 (dated status changes, regular value-added taxation, advance return
  periods), and the first part of slice 3 (payments from export files, one answer
  per counterparty, links to receipts and invoices, also by hand), receipt lines entered by
  hand, and the ten-day rule at the turn of the year for expenses and payments to
  the tax office. Open, in this order: the classifier reading lines off a receipt (waits for
  the extraction work on this roadmap); the rest of slice 3 (live bank sync with session
  expiry, card statement and pay-later importers, the ten-day rule for regularly
  recurring income); the income tax estimate; the year-end entry sheet; reading the
  expenses mailbox. Open inside what is built,
  each described in the plan's "Reality" sections: (1) the two older receipt columns
  "Business Share %" and "Zuordnung" and the per-vendor share table of the overview
  page are still read as a starting point and are removed only after the owner has
  finished entering the 2025 meals and the session preparing the 2025 return has
  been told; (2) the line numbers of the employment annex of 2026 are not yet
  compared with an official source, so those two lines show without numbers;
  (3) the 2027 rule set is due before 1 December 2026, when a test starts failing
  without it; (4) tax the buyer owes on services from abroad is not computed;
  (5) invoices carry no link to a contact yet. Plan:
  `docs/plans/2026-10-07-finance-tax-dashboard-and-advisory.md`. (2026-10-10)
- [ ] Business-meal register (Bewirtungsverzeichnis) and phone capture: all six
  slices are built (register, contact list, export, duplicate checks, page split,
  phone capture, classifier, offline queue, service worker, share target). Left
  before this can be ticked: (1) a pass by hand on a real phone (camera,
  home-screen install, offline queue) and one real upload through text recognition
  in production; (2) the owner's decision whether to keep the share target, which
  only works on Android (it is the last commit of the second pull request and can
  be reverted on its own); (3) confirm with the tax advisor the amount above which
  the receipt must name the host (set to 250 euros). Plan:
  `docs/plans/2026-10-06-meal-register-and-phone-capture.md`. (2026-10-07)
  - [x] Batch actions on the meals page, asked for after the first real use with 17
    open entries: a checkbox per entry and "select all" in the queue, a batch bar with
    "Keine Bewirtung" (out of queue and register, kept as a receipt, taken back from
    the new "Keine Bewirtung" list on the same page) and "Löschen" (row, stored file
    and guests, after an in-page confirmation), the same two actions on a single
    queue entry and on a register entry. A batch finishes the rest when one receipt
    is gone or belongs to another workspace, and a receipt whose stored file cannot
    be deleted is kept and reported. (2026-10-08)
  - [x] Visual polish of the meals page after the owner's review of the batch actions:
    a reusable custom checkbox (`src/components/ui/Checkbox.tsx`, real input, mixed
    state, 40 pixel hit area), no layout shift when an entry is checked (the batch bar
    has a reserved slot under the queue, outcome notices float, rows are a fixed grid; measured
    0 pixels at desktop and phone width), thin on-brand scroll bars and the dark colour
    scheme app-wide, quieter row actions, a destructive button that looks destructive
    at rest. Checked in a headless browser with screenshots. (2026-10-08)
  - [x] Receipt viewer and form fixes from the owner's live use: the receipt beside the
    form can be turned in quarter steps (stored with the file reference, so it is the
    same in the dashboard and on the exported register sheet; the stored file is never
    rewritten), zoomed, dragged and fitted, with keys R, plus, minus and 0. A PDF
    receipt is drawn to a picture in the browser (new dependency `pdfjs-dist`), so a
    sideways scan no longer sits as a strip in a browser frame. The place field opens
    with name and address read from the receipt text when a complete address is found
    there ("Aus Beleg übernehmen" for receipts that already have a place), and picking
    the host from browser autofill no longer overwrites the place. (2026-10-08)

## Completed

<!-- Done — move to CHANGELOG.md on release -->

- [x] A newly created Receipts table now carries its company from the first moment
  (`ensureReceiptsTable` and the dashboard's `createTable` stamp it right after
  creation, never overwriting an owner), with a database test. Before, a workspace
  created after the tenant backfill stayed without a company until the backfill was
  run again. (2026-10-07)
- [x] Branch the Drive-attach and Drive-browse 403 error mapping on Google's
  error body so an API-disabled GCP (Google Cloud Platform) project gets its own
  `drive_api_disabled` code/label instead of the misleading "reconnect Google"
  advice meant for a genuine missing-scope 403. (2026-09-10)
