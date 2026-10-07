---
title: Live finance and tax dashboard, scenario engine and advisory layer
summary: Turn the receipts app into the place where a sole proprietor sees profit, loss, depreciation and the expected income tax effect every day, can ask "what if" questions answered by the same tax code, and gets checkable hints (each with its inputs, its rule, its source and its euro effect) including a legal form comparison. Three stages, thirteen slices. Absorbs the bank connection and item-level receipts item.
type: plan
status: draft
tags: [receipts, tax, euer, dashboard, bank, enable-banking, assets, depreciation, scenario, advisory, legal-form, stateful-flow]
projects: [receipt-ocr-app]
date: 2026-10-07
---

# Live finance and tax dashboard, scenario engine and advisory layer

## Goal

The owner of this app is a sole proprietor in Germany, a small business under section
19 of the value-added tax act (Umsatzsteuergesetz, the "Kleinunternehmer" rule: no
value-added tax on invoices, none deducted from purchases), run next to a salaried
job. He files his own return. Preparing the 2025 return took a pass by hand of several
days over bank exports, invoices, receipts and three marketplaces.

The app should replace that pass with three things, built in this order:

1. **A live dashboard.** Revenue, expenses per line of the income-surplus statement
   (Einnahmenüberschussrechnung, EÜR, the cash-basis profit statement a small business
   files), depreciation and the asset register, the expected income tax effect and the
   expected refund or payment, updated daily, with every number traceable to its
   documents.
2. **A scenario engine.** "What if I buy X for Y euros on date Z at a business share
   of S" and "what if revenue is R next year", answered by the same tax code that
   computes the dashboard, never by a language model doing arithmetic.
3. **An advisory layer.** Hints on what can still be done this year, whether and when
   a purchase makes sense, and when a company with limited liability starts to pay
   off, each one showing its inputs, its rule, its source and its euro effect so it
   can be checked.

This plan is also the plan the roadmap asked for under "Bank connection and item-level
receipts: write the plan before any code". That item is folded into stage 1 (see
"Decisions this plan takes").

## The four design ideas

1. **One pure tax module computes everything.** `computeYear(facts, rules)` takes the
   facts of a year (items, payments, assets, wage data) and that year's rule set and
   returns every figure: form lines, profit, tax estimate. The dashboard calls it with
   the real facts. A scenario calls it with the real facts plus a list of changes. A
   hint is a scenario with a name. There is exactly one implementation of every rule,
   so the dashboard, a "what if" answer and a hint can never disagree.
2. **Computed on read, never stored.** The house rule of the meal register plan
   (`2026-10-06-meal-register-and-phone-capture.md`) applies to every derived figure:
   deductible amounts, form line totals, book values, the tax estimate, hint results.
   Stored are only facts and decisions. A derived figure therefore cannot go stale
   when a share, a category or a rule changes. The single exception is the snapshot of
   a filed year, which is stored on purpose (see "Year lifecycle").
3. **One queue of open checks is the resume path.** Like the queue of incomplete
   meals: an item that lacks a decision (vendor not classified, payment without a
   document, share missing, possible duplicate) sits in one list with its reason. That
   list is how work is resumed after a week away, how a backlog is worked off, and how
   the dashboard knows how complete it is.
4. **Every number says how far it can be trusted.** Each source has a "complete
   through" date (the bank feed of yesterday, the credit card statement of last
   month). The headline carries the weakest date of the sources it is built from, and
   every estimate names what is missing. A figure the app cannot compute is shown as
   missing with the reason, never as zero.

## What exists today (verified in code on `origin/main`, 2026-10-07)

- **Receipts** are rows of the generic data table (`dt_rows`, cells as JavaScript
  Object Notation, JSON, in `prisma/schema.prisma`), with the column list `COLUMNS` in
  `src/app/app/actions.ts` applied additively on every dashboard load. Relevant
  columns: Vendor, Gross, Net, Tax Rate, Date, Category (ten categories mapped to
  accounts of the German standard chart of accounts SKR03 in
  `src/lib/receipts-constants.ts`), Zuordnung (assignment: university, business,
  private), Currency, FX Rate (foreign exchange rate), Business Share %, Tax Lines.
- **Upload pipeline**: text recognition (`/api/ocr`), classification by a language
  model (`classifyWithWebSearch` in `src/lib/web-search.ts`), content hash and a
  look-alike check against duplicates (`src/lib/upload/duplicates.ts`), a row is kept
  even when text recognition fails.
- **Meal register**: `src/lib/meals/` with pure rules, the 70 percent deduction, a
  contact list behind the `ContactStore` interface, and `SmallBusinessStatus`, the
  section 19 status as dated entries.
- **Overview page** `/app/overview`: totals and charts over the receipt rows
  (`src/lib/overview/aggregate.ts`), with one business share per vendor in
  `WorkspaceVendorAttribution`.
- **Chat sidebar** (`src/lib/ai-chat-tools.ts`): a language model with tools that
  read and write table cells.
- **Access**: every table is partitioned by workspace and carries the company
  (`authTenantId`); guards in `src/lib/auth-guards.ts`.
- **Continuous integration** runs typecheck, lint, unit tests and database tests
  against a throwaway Postgres.
- **Outside the app**, in the owner's private files: a prototype that loads bank
  data through Enable Banking (an aggregator that reads bank accounts under the
  European payment services directive), matches card settlements and pay-later
  purchases to bank lines and builds a spending ledger; and the complete 2025 return
  worked by hand (one row per expense with form line, share and basis, and an entry
  sheet in the order of the tax forms). The second is the worked example this plan
  must reproduce.

**What the current model cannot express** (each one was needed for 2025):

| Needed for the return | Why today's columns fail |
|---|---|
| Home internet: 50 percent business plus 30 percent study | One share column, one assignment. The study part goes to a different form (the employment annex) than the business part. |
| Expense line of the tax form per item | Categories map to SKR03 accounts, not to form lines, and form line numbers shift between years. |
| Laptop written off over one year, a camera over several, small hardware at once | No asset, no useful life, no book value. |
| Customs charge that belongs to the purchase cost of an asset | No link between two documents that form one cost. |
| Expense counts in the year it was paid | Only the document date exists. No payments. |
| Invoice in US dollars booked at the euro amount the bank charged | Only a reference rate, no bank amount. |
| A payment with no invoice, an invoice with no payment | No payments, so neither list exists. |
| One order with a business item and a private item | One row per document, no lines. |
| Revenue by the date the client paid | No outgoing invoices, no incoming payments. |
| Salary, wage tax, insurance, loan interest | Nothing outside receipts. |

## Decisions this plan takes

Each is a recommendation until the owner confirms it on the decision page.

1. **The bank connection item is folded in.** Payments, matching and receipt lines
   are slices 2 and 3 of stage 1. Two plans describing the same payments table would
   drift. The roadmap line is rewritten to point here; its facts (application id,
   session rules, import sources, the two gates before other people link an account)
   are kept in "Bank data" below.
2. **Revenue gets a minimal invoice list here, behind a seam.** The decided Books plan
   (`2026-08-15-books-integration-pointer.md`; the full plan lives in the framer-clone
   repo) puts offers and invoices as documents into framer-clone. That schema is not
   built yet, and revenue by payment date is needed now. This repo therefore holds a
   list of issued invoices (number, date, client, amount), not a document tier: no
   templates, no numbering, no rendering. Reads go through an `InvoiceSource`
   interface, so the Books tier later becomes a second implementation, as the contact
   list was built.
3. **Money-carrying facts are typed tables with integer cents, not table cells.** The
   receipt row stays the document. Payments, links, lines, allocations and assets are
   Prisma models. The Books plan drew the same line for the same reason.
4. **Tax rules are code, one module per year, every value with its source.** A change
   in the law is a pull request with tests and a history, not an edit in a database.
5. **Stage 3 starts deterministic.** Rules and the scenario engine first. A language
   model that explains and answers questions is the last slice and its own decision.
6. **Operator only.** Every stage is built for the owner's own workspace. The data
   model stays workspace-scoped like everything else, but nothing here is offered to
   other people until the two gates in "Legal boundary" are passed.
7. **No real figures in this repository.** The repository is public. Tests use a
   synthetic year; the real 2025 data is read from the owner's machine by a test that
   is skipped everywhere else.

## Supported tax profile

Stated so the app can say "not covered" instead of computing something wrong:

- Covered: one natural person, single assessment, a business with a cash-basis
  statement under section 19, optionally employment income from a wage statement,
  study or training costs, special expenses (loan interest for education, church tax,
  donations), insurance contributions.
- Recorded but computed only as far as marked: church tax and solidarity surcharge
  (simple), insurance deductions (see "Income tax estimate").
- Not covered, and the estimate says so when such data is entered: joint assessment,
  children, rental income, capital income, trade tax above the allowance for
  partnerships, regular value-added taxation (see unhappy paths), balance sheet
  accounting.

---

# Stage 1: data foundation and live dashboard

## Data model

New Prisma models, all with `authWorkspaceId` and `authTenantId`, amounts as integer
cents, one migration per slice.

**Classification**

- `VendorRule`: how a vendor or counterparty is treated by default. Match key
  (normalized vendor name or a counterparty fingerprint), default classification
  (business, private, mixed, pass-through, own account), default form line key,
  `effectiveFrom`. Dated entries like `SmallBusinessStatus`: a change adds an entry
  from a date and never edits an old one. Replaces `WorkspaceVendorAttribution` and
  the constant `VENDOR_BUSINESS_SHARE_DEFAULTS`, which are migrated and deleted in the
  same slice.
- `Allocation`: who bears which part of an item. Target (a receipt row, a receipt
  line or a payment), purpose (`business`, `study`, `employment`, `private`), share in
  basis points, origin (`rule` with the rule entry id, or `manual`). An item can have
  several: 5000 business plus 3000 study leaves 2000 private. The shares of one item
  never exceed 10000. The old columns Business Share % and Zuordnung are read once to
  seed allocations and then removed from the column list.
- Form line: a stable key per item (`euer.telecom`, `euer.low_value_assets`,
  `euer.depreciation_movable`, `employment.study_costs` and so on), derived from the
  category by a per-workspace default and overridable per item. The printed line
  number and German label for a key come from the year's rule set.

**Documents and lines**

- `ReceiptLine`: one position of a receipt (description, quantity, gross, net, tax
  rate, category, optional asset link). A receipt without lines behaves as one line.
  Allocations and form lines can sit on a line, so one order can be part business,
  part private.
- New receipt columns (additive, self-healing): Invoice Number, Document Type
  (invoice, order confirmation, payment record, substitute voucher written by the
  owner, contract), Duplicate Of.

**Payments**

- `Account`: an own account (bank, card, payment service, pay-later service), with
  currency, source (`interface` or `import`) and `completeThrough`.
- `BankConnection`: an Enable Banking session: bank, `validUntil`, status. No key
  material; keys stay in Infisical.
- `ImportBatch`: one imported file with its content hash, source type, row count and
  the range of dates it covers.
- `Payment`: one booked movement. Account, booking date, value date, signed amount,
  currency, counterparty name, remittance text, the bank's entry reference, a source
  hash for idempotent imports, and `kind`: `spend`, `income`, `settlement` (a pay-later
  debit or card repayment that only settles earlier purchases), `own_transfer`,
  `refund`, `fee`, `cash`. Counterparty account numbers are stored as a keyed hash
  plus the last four characters, enough to recognize own accounts and repeat
  counterparties without keeping identifiers in clear.
- `PaymentLink`: payment to receipt row (or line), many to many, with the linked
  amount and the method (`reference`, `manual`). Covers one payment for several
  invoices, several payments for one invoice, a fee kept by a bank on the way, and a
  refund linked to the purchase it reverses.

**Revenue**

- `IssuedInvoice`: number, issue date, client (a `Contact`, reusing the contact
  store), amount, an optional file, and `declaredInYear` for invoices that an earlier
  return already declared under a different method, so they are never counted twice.
  Incoming payments link to issued invoices through `PaymentLink`.

**Assets**

- `Asset`: description, acquisition date, cost parts (links to the receipt lines that
  form the cost, including shipping and customs), business share, method
  (`immediate_low_value`, `pool`, `linear`, `digital_one_year`, `declining`), useful
  life in months, start book value for assets carried in from before the app, and a
  disposal (date, proceeds, kind: sold, scrapped, taken private). The schedule and the
  book value per year are computed from these and the year's rules.

**Person and year**

- `WageStatement`: per year and employer, the figures of the annual wage statement
  (gross wage, wage tax, solidarity surcharge, church tax, the employee and employer
  parts of the four insurances), entered by hand or read from the uploaded statement,
  plus an optional monthly figure for projecting the running year.
- `ReturnItem`: other items of the return by rule key and year (education loan
  interest, donations, days of home office, trips to a place of study), each with
  amount or count and an evidence link.
- `TaxSettings`: municipality trade tax multiplier, church tax rate or none, federal
  state. Extends `WorkspaceTaxSettings`.
- `TaxYear`: per year the status `open`, `exported`, `filed`, `assessed`; for a filed
  year a frozen snapshot of the figures with a hash of the inputs; for an assessed
  year the key figures of the assessment notice.
- `ChangeLog`: who changed which fact of a filed year, when, from what to what.

Names of clients and private counterparties live in typed tables, never in table
cells, so the chat sidebar's cell tools cannot hand them to a language model. Same
rule as for meal guests.

## Rules and calculations

One module `src/lib/tax/`:

- `rules/2025.ts`, `rules/2026.ts`: the rule set of a year. Every value is an object
  with the value, the legal source (statute and paragraph, or the ministry letter),
  a link, the date it was checked, and where needed a validity range inside the year
  (laws do change in July). Contains: income tax tariff, basic allowance, solidarity
  surcharge thresholds, employee flat allowance, low-value asset limit, pool limits,
  depreciation methods and their date ranges, useful-life table for the asset kinds in
  use, meal percentage, home office flat rates, section 19 limits, trade tax allowance
  and credit factor, corporate tax rate, flat tax on distributions, form line catalog
  (key, German label, line number of that year's form).
- `facts.ts`: one mapper from rows, lines, allocations, links, payments, assets and
  wage data to the normalized `YearFacts` the rules work on (the pattern of
  `src/lib/meals/record.ts`).
- `compute.ts`: `computeYear(facts, rules)`, pure, no input or output.

The rules it implements, each in plain words:

- **Cash basis.** An expense counts in the year it was paid, revenue in the year it
  arrived (section 11 of the income tax act, Einkommensteuergesetz). The date is the
  linked payment's date. A card purchase counts on the day of the charge, not the day
  the card bill is settled. Without a linked payment the document date is used and the
  item is flagged "date estimated". Regularly recurring payments within ten days
  before or after the turn of the year count for the year they belong to; such items
  are listed in a "year boundary" review with the rule cited, and the owner confirms
  each.
- **Amount.** A linked payment's euro amount wins over the document (this is how a
  US dollar invoice is booked at what the bank charged). Without a link: document
  amount times the reference rate already in the app, flagged "estimated". A voucher
  or discount reduces the cost; a refund reduces the expense in the year the refund
  arrived.
- **Shares.** Deductible amount = amount times share, rounded half up to the cent per
  item, then summed. The business share goes to the item's line of the statement; the
  study or employment share goes to the employment annex.
- **Section 19.** While the small-business status applies, the gross amount is the
  cost. The status is read from `SmallBusinessStatus` for the item's date.
- **Assets.** An item above the limit for immediate expense becomes an asset.
  Low-value assets (net price up to the limit; under section 19 the price is tested net
  and the gross amount is deducted) are expensed at once and still listed. Computer
  hardware and software may be written off over one year under the finance ministry's
  letter. Other assets follow the useful-life table, by month in the first year.
  Purchase cost includes shipping, customs and similar charges linked to the asset.
  Old assets carried at a reminder value stay at that value until disposed.
- **Meals.** The existing `mealDeduction`, unchanged: 70 percent of complete register
  entries only.
- **Revenue.** Sum of payments linked to issued invoices by payment date, less
  invoices marked as declared in an earlier year. An invoice not yet paid is shown as
  outstanding and is not revenue.
- **Statement.** Lines by form line key, totals, profit or loss, the asset annex.
- **Section 19 limits.** Revenue of the previous year against the previous-year limit
  and running revenue against the current-year limit, with a projection to year end.
- **Profit intention.** A plain notice when the pattern a tax office questions is
  present: losses in several years, or a loss large against revenue, offset against
  other income. It states what the tax office looks at (a forecast of total profit
  over the life of the business) and what evidence helps. This is a fact about the
  figures, shown on the dashboard, not held back for stage 3.
- **Income tax estimate.** Taxable income from the business result, the wage
  statement (work-related costs against the employee flat allowance, whichever is
  higher), special expenses and insurance deductions; tariff, solidarity surcharge,
  church tax; less wage tax already withheld and advance payments; the result is the
  expected refund or payment. It is always labelled an estimate and lists its missing
  inputs. Insurance deductions are computed by the standard rule; the comparison
  rules a tax office applies on top are not reproduced, and the estimate says so. The
  difference between a year computed with the business result and without it is shown
  as "what the business changed in your tax".

## Bank data

Kept from the roadmap item and the prototype:

- **Interface.** Enable Banking, registered application "Lumitra Receipts" (id
  `306d872b-bf50-4a18-95cb-3f17790470b7`), restricted production: it returns data only
  for accounts linked to the application itself, so it serves the operator's own
  accounts. Key and session ids are in Infisical (project Receipt OCR,
  `ENABLE_BANKING_*`).
- **Daily.** One scheduled sync per day per account through a machine-authenticated
  route, plus "refresh now" while the owner is present. The payment services
  directive limits fetches made without the user to a few per day and account, so
  "daily" is the honest promise, not "live". To confirm per bank before building.
- **Imports** for sources without a usable interface: card statement files, the
  pay-later purchase list, one bank's own export (its interface omits recipient
  names), the payment service's activity export, marketplace order exports. Each
  importer is idempotent by source hash; overlapping statements add nothing twice.
- **Settlements are not spending.** A purchase counts where it was made. The debit
  that later settles a pay-later purchase or a card bill is `settlement`, a transfer
  between own accounts is `own_transfer`; neither is an expense.
- **Matching** payment to receipt: by payment or order reference only, booked
  transactions only. Never by merchant name or amount alone: the pay-later service
  mislabels merchants and adds fees. No unique reference means a suggestion list
  (same amount, near date) that the owner confirms; the app never links on a guess.
  Before building, confirm per bank whether the entry reference is present, unique
  and stable.
- **Sessions.** `validUntil` is tracked (at most 180 days for most banks). The
  dashboard warns 14 days ahead; an expired session shows the account as stale with
  its last complete date and a button to authorize again.
- **Two gates before anyone but the operator links an account**: a Receipts section in
  the lumitra.co privacy policy, and public Enable Banking access (a signed contract
  and a completed company verification, know-your-business, KYB).

## Views

A new area `/app/finance` (German labels in the interface, as elsewhere):

- **Today** (`Übersicht`): year picker; revenue, expenses, profit or loss, expected
  refund or payment with "estimate" and its missing inputs; the section 19 meter; the
  profit intention notice when it applies; open checks by kind; freshness per source
  with its complete-through date.
- **Statement** (`EÜR`): every form line with its total, opening to the items behind
  it with document, payment, share and basis, in the shape of the 2025 entry sheet.
- **Open checks** (`Offen`): the queue. Kinds: vendor not classified, payment
  without document, document without payment, share missing, possible duplicate,
  amount estimated, date estimated, only an order confirmation on file, asset
  candidate undecided, income without invoice, year boundary. Keyboard save-and-next;
  "apply to all of this vendor" writes a vendor rule.
- **Assets** (`Anlagen`): the register with cost, method, depreciation of the year,
  book value at start and end, across years.
- **Revenue** (`Einnahmen`): issued invoices with payment date, outstanding ones,
  incoming payments without an invoice.
- **Years** (`Jahre`): revenue, expenses by line, result and tax estimate side by
  side for all years in the app.
- **Year end** (`Abschluss`): the entry sheet in the order of the tax office's online
  forms (ELSTER), one block per form with German labels, value and source, as a page,
  a PDF and a spreadsheet file; with the count of open checks named in a confirmation
  before export.

## Year lifecycle (a stateful flow)

`open` → `exported` → `filed` → `assessed`.

- **Exported**: the export carries a hash of its inputs. Any later change to a fact of
  that year makes the page say "changed since the export of <date>" and list the
  differing lines. An export is never silently outdated.
- **Filed**: the owner marks the year as filed. The figures are frozen in a snapshot.
  Facts of a filed year can still be corrected, but each change is logged and the year
  shows "differs from the filed return" with the difference per line, which is the
  basis for an amended return.
- **Assessed**: the owner enters the key figures of the assessment notice. The app
  shows the difference between its estimate and the assessment and keeps it as the
  track record printed next to every later estimate ("the 2025 estimate was off by
  so much").
- Retention: documents and payments of a filed year cannot be deleted in the app
  before the legal retention period for that record type ends; "delete" on such an
  item explains why and offers "exclude from the return" instead.

## Unhappy paths

| Situation | Behaviour |
|---|---|
| Bank session expired | Account marked stale with its last complete date; headline freshness drops to that date; one button starts a new authorization; the sync resumes from the last booked date, imports nothing twice. |
| Bank returns a transaction twice or changes a pending one | Only booked transactions are stored; identity is the source hash, so a repeat is ignored and reported in the sync log. |
| Bank omits the entry reference | Matching for that account falls back to the suggestion list; the account is labelled "no references" so the gap is visible. |
| Sync fails (bank down, rate limit) | The failure and its time are shown per account; the previous data stays; the next scheduled run retries; nothing looks fresh that is not. |
| Same statement file imported twice | Batch hash match: refused with a link to the earlier batch. Overlapping statements: row hash dedupes. |
| Import file in an unknown layout | Rejected whole with the first unreadable line shown; no partial import. |
| Payment without a document | Open check. Choices: attach a document, write a substitute voucher (reason required, marked as weaker evidence), mark private, exclude. |
| Document without a payment | Open check; amount and date flagged estimated until linked or confirmed as paid in cash. |
| Same purchase seen in three sources (order, card, receipt) | One purchase with several pieces of evidence: the receipt links to the payment, a second document of the same invoice number is `Duplicate Of` the first and counts once. |
| Refund, double debit | Negative payment linked to the original; nets to zero in the same year, reduces the expense in the refund's year otherwise. |
| One payment for three invoices minus a bank fee | Three links plus a fee line; revenue is the invoiced amounts, the fee is an expense. |
| Client pays without an invoice | Open check "income without invoice": revenue (then an invoice entry is required) or private. |
| Invoice paid in the following year | Outstanding at year end, revenue in the payment year. |
| Invoice file shows a wrong date or amount | The entry holds the corrected values and a note; the linked payment is what counts. |
| Vendor rule changed | Items from the rule's start date that follow the rule change with it; items with a manual allocation keep theirs; items before the date keep the old rule. |
| Category changed after a manual form line | The manual form line stays and the item is flagged "category and form line disagree". |
| Shares of one item above 100 percent | Rejected at entry. |
| Asset sold, scrapped or taken private | Disposal entry: remaining book value becomes an expense, proceeds become revenue, private withdrawal is flagged for the owner with the rule. |
| Item reclassified from expense to asset after export | Export marked changed; the difference list shows both lines moving. |
| Foreign currency without a rate and without a payment | Item incomplete with reason "exchange rate missing", never exported as zero. |
| No rule set for the running year yet | Computed with the latest year's rules under a banner "computed with the rules of <year>"; a test fails in continuous integration from 1 December when next year's module is missing. |
| A law changes within the year | The rule value carries a validity range; the rule set's "checked on" date is shown; items are evaluated by their own date. |
| Section 19 limit crossed, or regular taxation chosen | The status entry changes from a date. For periods under regular taxation the statement is not computed and the page says so with the reason: that mode (net amounts, value-added tax as its own lines, periodic returns) is a separate build, triggered by this event, see open decisions. |
| Wage data missing in the running year | Estimate shown without the employment part, labelled "business only", with the prompt to enter one pay slip. |
| Profile not covered (see above) | Estimate withheld for the uncovered part with the reason. |
| Wrong workspace | Every query is scoped to the active workspace; the workspace name is printed on every export. |
| Private payments and a language model | Payments are never sent to a model in stage 1. Classification of bank lines is by rule and by the owner's decision, asked once per counterparty. |

## Tests

- **Unit tests** for every rule in `src/lib/tax/`: rounding per item, shares, cash
  basis and the ten-day rule, each asset method by month, disposal, section 19 on and
  off, the tariff against the finance ministry's published calculator values for each
  rule year, the meter, the profit intention notice (fires, does not fire).
- **Properties**: a higher deductible expense never raises the tax; a scenario with no
  changes equals the baseline; line totals sum to the result; allocations never
  exceed the whole.
- **Synthetic golden year** in the repository: invented vendors and amounts with the
  same mix as the worked year (two-purpose shares, low-value assets, one-year
  hardware, an asset with customs, meals at 70 percent, a dollar invoice at the bank
  amount, a voucher, refunded double debits, duplicates, a payment without invoice,
  a wage statement, loan interest). Expected output: the full entry sheet.
- **Private golden year**, local only: reads the owner's real 2025 working files
  from a path in an environment variable and requires the per-line totals of the
  filed entry sheet to the cent. Skipped with a visible notice when the path is
  absent, so continuous integration never sees the data. Nothing from those files is
  committed.
- **Acceptance of stage 1**: 2025 loaded into the live app reproduces the filed entry
  sheet line by line.
- **Database tests**: migrations, workspace isolation of every new route, idempotent
  import, the migration of old shares into allocations.
- **Parser tests** with a real recorded interface response and one real file per
  import layout, with identifiers replaced.
- **The four paths**, for the queue, the year lifecycle, imports and the bank
  connection:
  1. Forward: import, classify, match, statement, export, filed, assessed.
  2. Backtrack and revise: change a share, a vendor rule, a category or a link after
     export and the export is marked changed with the right lines; change it back and
     the mark clears (same inputs, same hash). Unlink a payment and the amount falls
     back to "estimated".
  3. Resume: reload in the middle of the queue and the next open check is the same;
     an interrupted import leaves no half batch; a sync after an expired session
     continues from the last booked date.
  4. Re-entry: a second export after changes; a correction to a filed year is logged
     and shown as a difference; importing a file again adds nothing; a new bank
     authorization reuses the account and its history.
- A test per row of the unhappy-path table.

## Slices in build order

1. **Tax core and statement from what is already in the app.** `src/lib/tax/` with
   the 2025 and 2026 rule sets, form line keys, `VendorRule`, `Allocation` (old share
   data migrated, old table and constant removed), the open checks queue for
   classification, the Statement view. Usable alone: the expense side of the statement
   from uploaded receipts.
2. **Assets and receipt lines.** `ReceiptLine`, `Asset`, the Assets view, the asset
   annex, the classifier extended to read lines.
3. **Payments.** `Account`, `ImportBatch`, `Payment`, `PaymentLink`, the importers,
   then the Enable Banking sync with the daily schedule, matching, settlements,
   freshness, the remaining open check kinds.
4. **Revenue.** `IssuedInvoice` behind `InvoiceSource`, the Revenue view, the section
   19 meter, the profit intention notice.
5. **Income tax estimate.** `WageStatement`, `ReturnItem`, `TaxSettings`, the
   estimate, the Today view.
6. **Year end.** Entry sheet export, `TaxYear` lifecycle, snapshot, change log,
   assessment figures and track record, the Years view.
7. **Mail-in.** A dedicated address that invoices are forwarded to, feeding the
   normal upload pipeline (sender allow-list, attachments only, the same duplicate
   checks).

Slices 1 to 4 make the next return a matter of working off a queue. Slice 5 is what
turns the statement into "my tax situation today".

---

# Stage 2: scenario engine

## Goal

Answer "what if" with the tax module itself. A scenario is the real facts of a year
plus a list of typed changes; the answer is the difference between two runs of
`computeYear`.

## Design

- **Projection.** For the running year, facts are completed to year end: actual
  figures to date, plus recurring payments detected from the payment history, plus
  assumptions the owner states (revenue for the rest of the year, monthly wage). The
  result always shows "actual to date" beside "projected to year end" with the
  assumptions listed. For a future year the latest rule set is used and labelled.
- **Changes** (a closed, typed list): add a purchase (amount, date, business share,
  kind: expense, low-value asset, asset with a method), move a planned purchase to
  another date, change revenue, change wage, add a pension contribution, add or remove
  a recurring cost, change a share, dispose of an asset, change the legal form (stage
  3 uses this one).
- **Result.** Per change and in total: lines that move, profit or loss, tax, and the
  two numbers that matter for a decision: **tax effect** and **net cost** (price minus
  tax effect). Across years where a change reaches further (an asset written off over
  several years). And for money spent, the opportunity line: what the same amount
  would save if it reduced a recorded loan at its interest rate instead.
- **A scenario never writes to the books.** A saved scenario is a named list of
  changes, never a stored result. Results are computed on read and carry the hash of
  the facts and the rule set version they were computed from.
- `Scenario` model: name, year, changes (JSON validated by a schema on write and on
  read), created and updated times.
- View `/app/finance/scenarios`: a form per change type, the result table, compare up
  to three scenarios side by side, "turn into a planned purchase" does nothing in the
  books either; only a real receipt does.

## Unhappy paths

| Situation | Behaviour |
|---|---|
| Facts changed since the scenario was last viewed | Nothing is stale by construction; the page shows "books changed since you saved this" when the facts hash differs, with the baseline difference. |
| Scenario saved under an older change schema | Parsed by the reader for its version; a change that no longer parses is shown as "no longer supported" with its stored text, the rest still computes. |
| Purchase dated in a year without a rule set | Latest rules, labelled. |
| Input outside the supported profile | The affected part of the result is withheld with the reason. |
| Projection without enough history | Recurring costs are not guessed; the projection says "based on n months" and asks for assumptions. |
| Purchase near the low-value limit | Both treatments are shown side by side instead of picking silently. |

## Tests

Unit tests per change type; properties (no changes equals baseline; two changes
applied in either order give the same total where they are independent; net cost is
never below zero for a pure expense). The four paths: forward (build, save, read);
backtrack (edit a change and every derived figure follows, restore it and the result
is identical; change the books underneath and the notice appears); resume (reload
mid-edit keeps the draft, a saved scenario reads the same on another device);
re-entry (a scenario of a year that has since been filed still computes against the
filed snapshot and says so).

## Slices

8. **Projection and the change types** in `src/lib/tax/scenario.ts`, pure and tested.
9. **Scenario view**, saved scenarios, comparison.

---

# Stage 3: advisory layer

## Goal

Tell the owner what is worth looking at, with the proof attached. The measure is not
how clever a hint sounds but whether it can be checked in a minute.

## The shape of a hint

Every hint, without exception, is this record, computed on read:

| Part | Content |
|---|---|
| Rule | A stable id and one plain sentence of what the rule checks. |
| Inputs | The facts it used, each linking to its documents, with their complete-through dates. |
| Calculation | The scenario it ran, opened in the scenario view with one click. |
| Effect | Tax effect and net effect in euros, for this year and later years. |
| Source | Statute and paragraph or ministry letter, with link and "checked on". |
| Uncertainty | What is assumed, what is missing, what the app does not cover. |
| What a tax advisor should confirm | Named explicitly where the rule has a judgment call. |
| State | New, dismissed, done. A dismissal is stored with the hash of the inputs, so the hint returns only when its inputs change. |

A hint without a computable euro effect is shown as a notice, clearly apart from the
ones with an effect. Hints are ranked by effect, never by confidence wording.

One principle is printed with every purchase-related hint: **a deduction is a
discount, never a gain.** Spending 1,000 to save 350 of tax costs 650.

## Deterministic hints (first build)

Each is a pure function over `YearFacts` and the scenario engine, with a test where
it must fire and one where it must not.

1. **Low-value limit before a purchase**: a planned or recent purchase just above the
   limit, and what splitting or timing changes.
2. **This year or next**: the same purchase before and after the turn of the year,
   given both years' projected marginal rates. In a loss year next to a salary this
   often says "it makes no difference to wait" and says why.
3. **Investment deduction** (section 7g of the income tax act): reserving part of a
   planned purchase's cost in an earlier year. Effect, the conditions (business use,
   the profit limit, the deadline to actually buy) and the cost if the purchase does
   not happen.
4. **Depreciation method per asset**: the allowed methods side by side over the
   asset's life.
5. **Section 19 limits**: the projection approaching a limit, what changes when it is
   crossed, and the month it is expected.
6. **Section 19 the other way**: the value-added tax paid on purchases that could not
   be deducted this year, against the tax that would have been charged to clients who
   cannot deduct it, the periodic returns it brings, and the five-year binding.
7. **Foreign services**: purchases from suppliers abroad where the buyer may owe the
   value-added tax himself even under section 19. A compliance notice with the items
   listed, explicitly for a tax advisor to confirm.
8. **Home office flat rate**: days entered against the yearly cap, and the split
   between business and employment.
9. **Employee flat allowance**: study and work costs below the allowance have no
   effect; how far they are from it.
10. **Advance payments and reserve**: an expected payment, the amount to set aside
    monthly, and that an adjustment of advance payments can be requested.
11. **Pension contributions**: remaining deductible room and the tax effect of a
    contribution. Tax effect only; no product is named or compared.
12. **Loan against purchase or refund**: what an expected refund or a planned spend
    would save in interest on a recorded loan.
13. **Evidence at risk**: deductions resting on a payment without invoice or on an
    order confirmation only, with the amount at stake.
14. **Profit intention**: the stage 1 notice, extended with what would change the
    picture (a plan, a forecast, which costs drive the loss).
15. **Trade tax allowance**: the projection approaching it.
16. **Deadlines**: filing date, the date after which a late-filing surcharge is
    automatic, retention end dates.
17. **Legal form trigger**: projected profit entering the range where the comparison
    below starts to matter.

## Legal form comparison

A calculator, not a verdict. `compareLegalForms(profitPath, assumptions, rules)` runs
the same year computation for each form over a range of yearly profits and several
years.

- **Forms**: sole proprietor (today); company with limited liability in its two sizes
  (the entrepreneurial company, Unternehmergesellschaft, UG, and the
  Gesellschaft mit beschränkter Haftung, GmbH); partnership (only meaningful with a
  second founder, computed for a stated split).
- **Sole proprietor**: income tax at the personal rate on top of the salary,
  solidarity surcharge, church tax, trade tax above the allowance less its credit
  against income tax. A loss reduces the tax on the salary.
- **Company**: corporate tax, solidarity surcharge and trade tax (no allowance) on the
  company's profit; a managing director salary as company expense and personal income,
  with its payroll consequences listed as assumptions; tax on distributions, with the
  alternative method on request; the mandatory reserve of the UG; **a loss stays in
  the company and cannot be set against the salary**, shown as its own line because
  for a founder with a job and start-up losses it is often the largest number on the
  page.
- **Costs as editable assumptions**, each with a default marked as an assumption:
  founding (notary, register, capital), yearly (double-entry bookkeeping, annual
  accounts, their publication, tax returns, chamber fees), and the owner's time.
- **Output**: total burden and what stays in hand per form and profit level; the
  break-even as a **range** with the assumptions that move it most, never a single
  number; a table of what is not money (liability, how clients and investors see the
  form, taking profit out, selling the business later, effort).
- **Ends with a hand-off**: a one-page brief (figures, assumptions, open questions)
  to take to a tax advisor. The decision to found a company is not one the app
  presents as made.
- Constants this needs (corporate tax rate and its announced steps, surcharge, the
  municipality's trade tax multiplier, allowance and credit factor, flat tax on
  distributions, capital and reserve rules) enter the rule sets with sources like
  every other value. None is asserted in this plan; the knowledge-base roadmap already
  carries an open item to verify the tax figures of the small-business guide, and the
  same check applies here.

## Keeping the rules current

- One module per year, reviewed like code. Each value has source, link and "checked
  on"; the rule set has a "last reviewed" date shown in the interface.
- A dated roadmap line each November: enter next year's rule set. The continuous
  integration test from 1 December makes forgetting it visible.
- A law changed mid-year is a value with a validity range plus a note in the
  changelog; hints computed before the change are recomputed on read by construction.
- The finance ministry's calculator values are the test vectors for the tariff; each
  assessed year is the test of the whole.

## Catching wrong advice

1. One implementation: hint, scenario and dashboard share `computeYear`.
2. Worked years as tests: the synthetic year in the repository, the real 2025 locally.
3. The track record: estimate against assessment notice, per year, displayed.
4. Every hint has a firing and a non-firing test, and the properties of stage 2.
5. A hint whose inputs include an estimated or missing fact says so in its
   uncertainty part and is ranked below hints on complete facts.
6. "What a tax advisor should confirm" is a required field for rules with a judgment
   call; a rule without sources does not ship.

## The language model, last and optional

What it may do, as slice 13:

- Explain a computed hint in plain language.
- Answer a question by calling tools: `get_year_summary`, `run_scenario`,
  `list_hints`, `compare_legal_forms`. Tools return aggregates and business items
  only; private payments and names of private persons are never in a tool result.
- Suggest ideas the rule list does not cover, shown under "unverified ideas", with no
  euro figure unless a tool computed it.

What it may never do: originate a figure or a legal conclusion. Mechanically: every
euro amount and percentage in an answer must appear in a tool result of the same
turn; an answer that fails this check is not shown, and the raw result table is shown
instead with a note. The model receives the cited rule notes as context, not the
statute from memory.

## Legal boundary

In Germany, helping others with their individual tax matters as a business is
reserved to tax advisors and a few other professions (Steuerberatungsgesetz, the tax
advisory act). A person computing his own taxes with his own software is not helping
others. That gives two regimes:

- **Operator's own workspace (this plan).** The app may be frank: ranked options with
  euro effects. It still shows inputs, rule, source and uncertainty, and still hands
  off the legal form question, because that is what makes the output worth trusting,
  not because the law demands it here.
- **Anyone else.** Not offered. Before that changes: (1) a written opinion from a
  lawyer on where calculation software ends and individual tax advice begins for
  exactly this feature set; (2) the wording contract below enforced in the interface;
  (3) the two bank data gates above. Likely outcome to plan for: calculations,
  scenarios and general information with sources stay, individualized
  recommendations and the legal form conclusion go to a cooperating tax advisor.
- **Wording contract** (already followed in the operator build so nothing has to be
  rewritten later): "calculation", "scenario", "comparison", "hint", "what a tax
  advisor should confirm". The interface never says "we advise", "you should" or
  "tax advice". Every page of this stage carries one line: figures are calculations
  from your own data for your own decision; they do not replace a tax advisor.

## Unhappy paths

| Situation | Behaviour |
|---|---|
| Inputs of a hint are incomplete | Shown with the missing facts named, ranked lower, effect given as a range or withheld. |
| A dismissed hint's inputs change | It returns as new, with what changed. |
| Rule set older than the facts' year | Hints carry "computed with the rules of <year>". |
| Two hints contradict (buy now, reserve for later) | They are grouped as alternatives of one decision with both effects, never listed as two things to do. |
| Legal form comparison with a loss | Shown; the trapped loss line dominates and the page says the comparison is not yet meaningful, with the profit level where it becomes so. |
| Cost assumptions left at defaults | The result is labelled "with default cost assumptions" and names the three that matter most. |
| Model unavailable or its answer fails the number check | The deterministic page works without it; the failed answer is replaced by the result table. |
| Question outside the covered profile | The answer says what is not covered and offers the advisor brief. |

## Tests

Firing and non-firing per hint; grouping of contradicting hints; dismissal keyed to
inputs (the four paths: forward; change an input and the dismissal no longer applies,
restore it and the dismissal applies again; reload keeps states; a year that was
filed keeps its hints readable against the snapshot). Legal form: each form's burden
at fixed profit levels against hand-computed tables, monotonic burden in profit, the
loss case, sensitivity to each cost assumption. Model slice: the number check against
recorded answers that contain an invented figure, a tool result that contains a
private name is impossible by the tool's own tests.

## Slices

10. **Hint framework and the first hints** (numbers 1, 2, 5, 9, 10, 12, 13, 14, 16):
    the ones that need nothing beyond stages 1 and 2.
11. **Remaining hints** (3, 4, 6, 7, 8, 11, 15, 17), each with its sources entered.
12. **Legal form comparison** and the advisor brief.
13. **Language model layer** with the number check. Own decision.

---

## Relationship to other plans

- **Books** (framer-clone, decided): this plan does not build an invoice document
  tier. `InvoiceSource` is the seam. The Books plan's read endpoint
  `GET /api/books/expenses` gets its data from the same `YearFacts` mapper once slice
  1 exists, so there is one definition of an expense line. Books is scoped to the
  company, this app to the workspace; every new table carries both ids, as the
  existing ones do.
- **Meal register** (this repo, in progress): reused unchanged; its register is one
  form line of the statement.
- **Knowledge-base roadmap**: carries the cross-repo item to connect expense tracking
  and invoicing into one tax and accounting plan, and the item to verify tax figures.
  This plan is the receipts half of the first and depends on the second for its
  constants.

## Open decisions for the owner

Each with a recommendation; answers are recorded below once given.

1. **Approve the direction and the order of stages.** Recommended: yes.
2. **How much to build now.** The owner's first goal is recurring revenue from the
   Studio product, and this app is kept as an internal tool. Recommended: slices 1 to
   4 now, because the 2026 books are already nine months behind and each month adds to
   the pass by hand; slice 5 and 6 before the 2026 return; stages 2 and 3 after.
3. **Fold the bank connection item into this plan.** Recommended: yes.
4. **Revenue before Books exists.** Recommended: the minimal invoice list here.
5. **Tests with real figures.** Recommended: synthetic year in the public repository,
   real 2025 only locally.
6. **Who the app is for.** Recommended: operator only for all stages.
7. **Advisory wording for own use.** Recommended: frank ranking by euro effect under
   the wording contract.
8. **Language model in the advisory layer.** Recommended: decide after the
   deterministic hints have been used for one return.
9. **What may reach a language model.** Recommended: aggregates and business items
   only, never payments classified private, no model on raw bank lines.
10. **Regular value-added taxation mode.** Recommended: build when a status change is
    actually planned; until then the app states plainly that it does not compute it.
11. **Filing through the tax office's interface.** Recommended: no; the entry sheet is
    typed in by hand, as for 2025.
12. **Mail-in address.** Recommended: yes, as slice 7.
13. **One session with a tax advisor** to confirm the judgment calls collected under
    "what a tax advisor should confirm" (asset limit under section 19, foreign
    services, the profit intention picture, study costs beside a salary) before the
    first return is filed from the app. Recommended: yes.
