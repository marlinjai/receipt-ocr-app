# Roadmap

## Planned

- [x] The 2025 purchase documents from the tax folder are in the app: 221 under Whiz-Art Media
  (241 receipts with the 20 that were there), 12 private ones under "marlinjai". Two files were
  already present and were not added again. Missing dates were filled from the tax session's
  table, and assignment and share were set from its draft expense table. Done 2026-10-10.
- [x] Shares the assignment column cannot hold are set: 50 percent business plus 30 percent
  study on the 12 Telekom home internet and the 12 Notion invoices (per receipt, in the finance
  area, study part on "Fortbildungskosten"), and 50 percent study on the 12 invoices of the older
  mobile contract (Marlin's answers of 2026-10-06 to the tax decision page). Done 2026-10-10.
- [x] Sub rows in the receipts table, like sub-items in Notion: a group Marlin creates (a parent
  row as a container, its receipts underneath, the parent showing their sum and never counting
  as a receipt itself). Built with `@marlinjai/data-table-react` 0.6.0. Clicked through on
  production on 2026-10-11: a group made from two receipts, both drawn underneath it, the
  section count and the 241 items unchanged, folding, the state kept over a reload, one receipt
  taken out, the group dissolved with its confirmation and both receipts back at the top level.
  Plan: [receipt sub rows](docs/plans/2026-10-11-receipt-sub-rows.md). Done 2026-10-11.
- [ ] A group's sum quietly leaves out a receipt that has no value in the summed column. Seen on
  production on 2026-10-11: two receipts in a group, one without a euro equivalent, and the
  group showed the euro sum of the other one alone with no sign that it is incomplete. Show
  that a sum is incomplete (how many receipts it covers) instead of a clean number. Also not
  yet proven on production: dragging a group from one section into another. (2026-10-11)
- [ ] A receipt with its parts as sub rows, the second use of sub rows (further values of the
  hidden `Row Kind` column). Not built; the group design leaves room for it. (2026-10-11)
- [ ] Read receipts with a model that sees the page, not only the recognized text. The wrong
  totals of the 2025 import (net stored for gross on 26 receipts) came from text recognition
  that returns labels and amounts in separate runs, after which the reader believed a language
  model that had only that text, cut at 6,000 characters. The fixes of 2026-10-11 settle the
  total from the invoice's own arithmetic; what they cannot settle (a total that only its
  position on the page pairs with its label, such as the customs invoice) needs either the
  word positions the text recognition already returns or a vision model given the image. Write
  the plan: which model, what it costs per receipt, and how its answer is checked against the
  arithmetic. Asked for by Marlin on 2026-10-11. (2026-10-11)
- [ ] Bring the app up to the tax session's draft for 2025. The gap is explained to one cent
  (2026-10-11): the app showed 7,547.54 euros of business expenses, the draft table
  (`entwurf-ausgaben-2025.csv` in the 2025 tax folder) 14,344.35. The steps: the MacBook waits
  as an open check for its asset (2,849.00), seven hardware invoices and other documents on
  disk were never imported (2,806.23), items paid without a document (749.56), five small
  orders without any evidence (128.20), two receipts blocked by an open check (342.17), and
  wrongly read amounts and exchange rates (134.74). Marlin answered the 17 questions on
  2026-10-11 (recorded in `Entscheidungen-2025.md` in the tax folder); being carried out:
  the imports, the asset, the bank and PayPal files into the payments, the corrected amounts.
  Waiting on Marlin: the business meals, which he completes in the register himself.
  (2026-10-11)
- [ ] Check the reader's new date and total reading against the text production actually stores.
  The fixes of 2026-10-11 were measured on local text extraction of the 2025 purchase documents,
  with the labels torn from their amounts to imitate the text recognition, because the stored
  recognized text was not at hand. Read the "OCR Text" cells of the imported rows and rerun the
  reader over them. Known to remain: a customs invoice whose total (226.14) cannot be paired
  with its label once the two are torn apart, which needs the word positions the text
  recognition returns; four documents without a total when the model gives none (three
  Namecheap, one order page); two totals that came from the model and could not be reproduced
  (one Cursor, one Namecheap). (2026-10-11)
- [ ] Classification rules a user writes live in browser storage and never reach the upload
  path, so a rule such as "this vendor is private" cannot apply when a receipt is uploaded.
  Since 2026-10-11 the model leaves the assignment empty unless the document shows it, and an
  empty assignment is asked for in the review list. Decide whether the rules move to the
  server. (2026-10-11)
- [x] The reader finds the invoice date on Google, Adobe, Apple and Microsoft invoices: every
  date is ranked by the label in front of it, a due, renewal or debit date is never taken (58
  of 302 documents without a date before, none after, on local text). Totals: net, tax and
  their printed sum settle the total in any currency, the "Total" line stands where a credit is
  applied, and a long invoice reaches the model with its end, which fixes the net-for-gross
  readings (13 OpenAI invoices among them). The phone leasing application states no total, and
  that is now pinned by a test. Done 2026-10-11.
- [x] The reader's first guess "Privat" on 65 of 221 business invoices came from the classifier
  prompt, which offered the three assignments with no meaning and no way to leave the field
  open. The model now answers only what the document shows and leaves the assignment empty
  otherwise; the review list asks for it ("Zuordnung fehlt"). Done 2026-10-11.
- [x] Removed the receipts app's own contacts table and the `CONTACTS_STORE` switch (wave 4 of
  the shared contact list). The shared contacts database is the only contact store; a missing
  company or a missing `CONTACTS_DATABASE_URL` fails loudly instead of falling back. Migration
  `0018_drop_own_contacts_table` drops the table `contacts` in the receipts database on deploy
  (4 stale rows, copied to the shared database under the same ids on 2026-10-09). Released on
  Marlin's own yes. The unused `CONTACTS_STORE` entry was removed from the production secret
  project the same day. Plan: `docs/plans/2026-10-10-remove-own-contacts-table.md`. (2026-10-10)
- [ ] Issued invoices with more than one tax rate. An issued invoice carries one tax treatment
  (standard or reduced rate). Its stored tax amount is right, but the advance value-added tax
  return would report the whole turnover under that one rate, so an invoice with 7 and 19 percent
  lines would be misreported. Store the tax groups per invoice and report each under its own rate.
  From the finance dashboard work. (2026-10-10)
- [ ] A signed-in live write pass of `/app/finance` on production, under Whiz-Art Media, which
  holds the receipts since the move of 2026-10-10: open each tab, write one
  synthetic decision, vendor rule and payment link, remove them again, and confirm the numbers
  return. Only a read-only pass was done (2026-10-10 08:53). From the finance dashboard work.
  (2026-10-10)
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

- [ ] Two tax rates, two columns, one order. On a receipt with two tax rates, the number column
  "Tax Rate" takes the first of the reader's printed tax groups ordered by gross
  (`src/lib/extraction/amounts.ts`), while the text column "Tax Rates" follows the model's meal
  tax lines ordered by net (`src/lib/tax-rates.ts`, written in `readReceipt`). The two can name a
  different first rate when the two sources disagree. Decide one source of truth for the order
  and make both columns follow it, with a test where the sources disagree. Found while landing
  the capture queue fix. (2026-10-10)
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
- [x] Business receipts moved to the company Whiz-Art Media (Marlin's rule: business under
  Whiz-Art Media, personal under "marlinjai", one company per receipt by tax purpose). The whole
  workspace with its 24 receipts, 16 business meals and 3 guest rows moved through auth-brain with
  all ids kept, its 4 contacts went along (29 under Whiz-Art Media, 0 under "marlinjai"), and
  "marlinjai" has a fresh empty workspace. The receipts side is the signed endpoint `POST
  /api/internal/workspace-move` (how to call it: `docs/operations/workspace-move.md`). Run on
  Marlin's yes and verified in both databases and in the browser. Plan:
  `docs/plans/2026-10-10-business-receipts-to-whiz-art-media.md`. Done 2026-10-10.

- [ ] Remove what the retired empty Whiz-Art Media workspace leaves in the receipts database.
  Workspace `01a12296-b963-7018-8857-5e76ffe01c87` was created empty on 2026-10-09 and was retired
  in auth-brain on 2026-10-10, when the business receipts moved to Whiz-Art Media. A visit had
  created a Receipts table with 0 receipts and one tax settings row for it; nothing reads them
  now. Removing them is a delete on production: it needs Marlin's one-line yes, with the dump
  `receipts-before-workspace-move-20261010T122443Z.dmp` on the server as the way back.
  (2026-10-10)

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
  the tax office. Open, in this order: the classifier reading lines off a receipt (unblocked:
  the receipt reader rebuild merged on 2026-10-10 as pull request 51); the rest of slice 3 (live bank sync with session
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

- [x] Phone capture queue: a photo the server has is never sent again. Sending a queued photo and
  removing its entry were one step, so a failed removal looked like a failed send: the photo was
  reported as not processed, its attempts were raised, and every later run sent it again (kept
  from becoming a second receipt only by the duplicate check, which stops helping once the
  receipt was deleted on purpose). Now two steps with two outcomes: a failed removal marks the
  entry as sent, later runs only retry the removal, also without a connection, and the screen
  says so. This is the capture half of a reviewed fix that missed its merge: it was committed in
  the same second pull request 31 merged on 2026-10-07 and was never pushed. Its other half (the
  tax rate of a meal with several tax lines) is not ported: the receipt reader rebuild names the
  rate that carries most of the bill, and pull request 60 lists every rate. Done 2026-10-10.
  (2026-10-10)
- [x] A newly created Receipts table now carries its company from the first moment
  (`ensureReceiptsTable` and the dashboard's `createTable` stamp it right after
  creation, never overwriting an owner), with a database test. Before, a workspace
  created after the tenant backfill stayed without a company until the backfill was
  run again. (2026-10-07)
- [x] Branch the Drive-attach and Drive-browse 403 error mapping on Google's
  error body so an API-disabled GCP (Google Cloud Platform) project gets its own
  `drive_api_disabled` code/label instead of the misleading "reconnect Google"
  advice meant for a genuine missing-scope 403. (2026-09-10)
