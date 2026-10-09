---
title: Live finance and tax dashboard, scenario engine and advisory layer
summary: Turn the receipts app into the place where a sole proprietor sees profit, loss, depreciation and the expected income tax effect every day, can ask "what if" questions answered by the same tax code, and gets checkable hints (each with its inputs, its rule, its source and its euro effect) including a legal form comparison. Three stages, fourteen slices. Absorbs the bank connection and item-level receipts item.
type: plan
status: in-progress
tags: [receipts, tax, euer, dashboard, bank, enable-banking, assets, depreciation, scenario, advisory, legal-form, stateful-flow]
projects: [receipt-ocr-app]
date: 2026-10-07
---

# Live finance and tax dashboard, scenario engine and advisory layer

## Goal

The reference user of this app is a sole proprietor in Germany, a small business under
section 19 of the value-added tax act (Umsatzsteuergesetz, the "Kleinunternehmer" rule:
no value-added tax on invoices, none deducted from purchases), run next to other
income. They file their own return. Preparing a yearly return by hand takes days over
bank exports, invoices, receipts and several marketplaces.

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

All confirmed by the owner on 2026-10-07; his answers and the changes they caused are
under "Decisions (2026-10-07)" at the end.

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
6. **Operator only, for now.** Every stage is built for the owner's own workspace.
   The owner expects to offer it to customers later, so the data model stays
   workspace-scoped like everything else and the wording contract of stage 3 is
   followed from the first build, but nothing here is offered to other people until
   the gates in "Legal boundary" are passed.
7. **No real figures in this repository.** The repository is public. Tests use a
   synthetic year; the real 2025 data is read from the owner's machine by a test that
   is skipped everywhere else.

## Supported tax profile

Stated so the app can say "not covered" instead of computing something wrong:

- Covered: one natural person, single assessment, a business with a cash-basis
  statement, under section 19 or (from slice 5) under regular value-added taxation,
  optionally employment income from a wage statement,
  study or training costs, special expenses (loan interest for education, church tax,
  donations), insurance contributions.
- Recorded but computed only as far as marked: church tax and solidarity surcharge
  (simple), insurance deductions (see "Income tax estimate").
- Not covered, and the estimate says so when such data is entered: joint assessment,
  children, rental income, capital income, trade tax above the allowance for
  partnerships, balance sheet accounting, value-added tax special cases (supplies
  to other countries, margin schemes, partial input tax deduction beyond the
  business share).

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
  store), amount (net, tax rate, tax, gross, and the tax treatment: section 19,
  standard, reduced, reverse charge), an optional file, and `declaredInYear` for invoices that an earlier
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
- `VatPeriod`: per advance return period (month or quarter, as the tax office set
  it) the status `open` or `filed`, and for a filed period the frozen figures with a
  hash of the inputs, like `TaxYear`. The period's figures themselves are computed on
  read.
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
- **Section 19 turnover.** The limits are tested against their own figure, the
  section 19 total turnover (`Gesamtumsatz`), not the generic revenue above. It sums
  the consideration actually received in the calendar year (net of tax, by receipt
  date), excluding sales of fixed assets and the exempt transactions the statute
  names (for example the ones listed in section 19 paragraph 3). An unpaid invoice is
  a forecast value until payment arrives, and the invoice issue date alone never
  changes the status.
- **Section 19 limits and their forecast.** Section 19 turnover of the previous year
  against the previous-year limit and running section 19 turnover against the
  current-year limit. The
  forecast projects turnover forward (invoices issued and unpaid, the run rate of the
  last months, and what the owner states he expects) and names the date each limit
  is expected to be reached, as a range. It then says what follows: crossing the
  previous-year limit changes the status from 1 January of the next year; crossing
  the current-year limit changes it at once, starting with the invoice that crosses
  it. From a set lead time before that date the dashboard shows a preparation list:
  invoices must show the tax from the change date, the advance return period the tax
  office will expect, which running contracts and prices are quoted gross, and which
  recent purchases would have carried deductible tax. The forecast adds a planned
  dated entry to nothing by itself: the status entry is written by the owner when the
  change is real.
- **Regular value-added taxation.** For any date on which `SmallBusinessStatus` says
  "not a small business": costs count net, the tax on a purchase is input tax as far
  as the business share reaches (the private and study shares carry no input tax),
  issued invoices carry output tax, and under the cash-basis statement tax received
  is revenue and tax paid (to suppliers and to the tax office) is expense in the year
  it flows, on their own form lines. Per advance return period the app computes
  output tax, input tax and the amount due, and at year end the figures of the
  annual value-added tax return. Whether tax is owed by payment date or by invoice
  date is a setting (the tax office grants the first on request); it is asked once
  and is required before any period is computed. Tax owed by the buyer on services
  from abroad is listed per item for both statuses.
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

- **Interface.** Enable Banking, registered application "Lumitra Receipts" (id in
  Infisical as `ENABLE_BANKING_APP_ID`, never written into this repository), restricted production: it returns data only
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
  refund or payment with "estimate" and its missing inputs; the section 19 meter
  with its forecast date and, when due, the preparation list; the
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
- **Value-added tax** (`Umsatzsteuer`): under section 19 the limits, the forecast
  and the tax on purchases that could not be deducted; under regular taxation the
  advance return periods with output tax, input tax, amount due, due date and the
  items behind each figure, plus the annual figures.
- **Years** (`Jahre`): revenue, expenses by line, result and tax estimate side by
  side for all years in the app.
- **Year end** (`Abschluss`): the entry sheet in the order of the tax office's online
  forms (ELSTER), one block per form with German labels, value and source, as a page,
  a PDF, a spreadsheet file and a machine-readable file keyed by form and field; with
  the count of open checks named in a confirmation before export.

## Filing

The app does not submit returns through the tax office's software interface; that is
planned only once customers use the product. For the owner's own returns the entry
is assisted instead: a coding session drives the owner's logged-in browser, types the
machine-readable entry sheet into the ELSTER forms field by field, saves the draft
and compares ELSTER's own draft view against the sheet. Every mismatch is listed. The
same applies to an advance return period. Sending the return is a legally binding
declaration: the session always stops at the saved draft, and the owner sends it
himself after he has read the comparison (decided 2026-10-07).

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
| Section 19 limit crossed, or regular taxation chosen | The owner adds a status entry from a date. Items before the date keep gross as cost, items from the date are computed net with input tax; a year can contain both and the statement shows them on their respective lines. |
| Forecast says a limit will be crossed | Preparation list and date range on the dashboard; nothing changes in the books until the status entry is written. A forecast built on fewer than three months of data says so. |
| Limit already crossed but no status entry | A blocking notice on the Today and Value-added tax views naming the invoice that crossed it; invoices issued after it without tax are listed as needing correction. |
| Invoice issued with the wrong tax treatment for its date | Open check on the invoice; the tax shown on an invoice is owed even when shown in error, and the check says so. |
| Asset bought under section 19, status changes later (or the reverse) | Listed as "input tax correction to review" with the rule cited, for a tax advisor to confirm; no correction is computed silently. |
| Advance return period filed, then a fact of that period changes | Period shows "differs from the filed return" with the difference, the basis for a corrected return. |
| Taxation method (by payment or by invoice date) not set | No period figures; the view asks the question. |
| Wage data missing in the running year | Estimate shown without the employment part, labelled "business only", with the prompt to enter one pay slip. |
| Profile not covered (see above) | Estimate withheld for the uncovered part with the reason. |
| Wrong workspace | Every query is scoped to the active workspace; the workspace name is printed on every export. |
| Private payments and a language model | Payments are never sent to a model in stage 1. Classification of bank lines is by rule and by the owner's decision, asked once per counterparty. |

## Tests

- **Unit tests** for every rule in `src/lib/tax/`: rounding per item, shares, cash
  basis and the ten-day rule, each asset method by month, disposal, section 19 on and
  off, a status change in the middle of a year, input tax limited to the business
  share, an advance return period by payment date and by invoice date, the forecast
  date for a steady and for a jumping revenue path, the tariff against the finance ministry's published calculator values for each
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
4. **Revenue and the limit forecast.** `IssuedInvoice` behind `InvoiceSource`, the
   Revenue view, the section 19 meter with its forecast and preparation list, the
   profit intention notice.
5. **Regular value-added taxation.** Net and input tax in `computeYear`, the tax
   form lines, `VatPeriod`, the Value-added tax view, the status change inside a
   year, the annual figures.
6. **Income tax estimate.** `WageStatement`, `ReturnItem`, `TaxSettings`, the
   estimate, the Today view.
7. **Year end.** Entry sheet export including the machine-readable file for assisted
   entry, `TaxYear` lifecycle, snapshot, change log, assessment figures and track
   record, the Years view.
8. **Mail-in.** The owner already collects invoice mail in one dedicated expenses
   mailbox and is moving his vendors' billing addresses to it. The app reads that
   mailbox (no new address): each attachment from an allowed sender goes through the
   normal upload pipeline with the same duplicate checks, the message is marked as
   taken, and a mail that could not be read stays in the mailbox and appears as an
   open check.

Build order decided: slices 1 to 5 now (the owner asked for the regular mode and the
forecast to be part of the first build), slices 6 and 7 before the 2026 return, slice
8 after. Slices 1 to 4 make the next return a matter of working off a queue. Slice 6
is what turns the statement into "my tax situation today".

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
  a recurring cost, change a share, dispose of an asset, change the value-added tax
  status from a date, change the legal form (stage 3 uses this one).
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

9. **Projection and the change types** in `src/lib/tax/scenario.ts`, pure and tested.
10. **Scenario view**, saved scenarios, comparison.

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
5. **Section 19 limits**: the stage 1 forecast as a hint with its euro effect: what
   crossing costs or brings, computed as a scenario with the status changed from the
   forecast date.
6. **Section 19 the other way**: choosing regular taxation on purpose, computed as a
   scenario with the status changed from 1 January: the tax on purchases that
   becomes deductible, against the tax charged to clients who cannot deduct it, the
   periodic returns it brings, and the five-year binding.
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

What it may do, as slice 14:

- Explain a computed hint in plain language.
- Answer a question by calling tools: `get_year_summary`, `run_scenario`,
  `list_hints`, `compare_legal_forms`. Every tool has an allowlisted response
  schema of aggregates and business item fields only (amounts, dates, categories,
  rule ids). Names of natural persons never appear in a schema, including client
  names from `Contact` records: contacts are referenced by an opaque id. Each tool's
  serialized output is validated against its schema before it reaches the model, and
  a tool without a schema and validator is not enabled. Private payments are never
  in a tool result.
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
- **Anyone else.** Not offered yet; the owner intends to offer it to customers later.
  Before that changes: (1) a written opinion from a
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

11. **Hint framework and the first hints** (numbers 1, 2, 5, 6, 9, 10, 12, 13, 14,
    16): the ones that need nothing beyond stages 1 and 2.
12. **Remaining hints** (3, 4, 7, 8, 11, 15, 17), each with its sources entered.
13. **Legal form comparison** and the advisor brief.
14. **Language model layer** with the number check. Own decision, taken after one
    return has been prepared with the rule-based hints.

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

## Reality after slice 1 (2026-10-07)

Built as planned, with these differences and facts worth knowing:

- **Only decisions are stored, even less than planned.** The draft had an
  `Allocation` table with an origin per row. Built instead: `TaxItemDecision` (one
  per receipt, only when a person overrode something) and `TaxVendorRule` (dated
  entries per vendor), migration `0009_tax_decisions`. The treatment of a receipt
  is resolved on read, strongest first: its own decision, the vendor rule in force
  on its date, then the older columns and the category default. Nothing derived
  from a rule is ever written, so a changed rule needs no rewrite of items.
- **The older columns are still read, not yet removed.** "Business Share %" and
  "Zuordnung" serve as the starting point for receipts nobody has decided in the
  new way, and the overview page still uses them and `WorkspaceVendorAttribution`.
  Removing them touches the overview page, the sheet import and the chat tools,
  and the owner is entering 2025 meals in the live app right now. The removal is a
  separate step, tracked on the roadmap line, announced to the session preparing
  the 2025 return before it ships.
- **There is no dated section 19 status yet.** This plan assumed the meal register
  had built `SmallBusinessStatus` as dated entries. It built one yes or no answer per
  workspace (`WorkspaceTaxSettings.smallBusiness`). The tax module already takes
  the status per item; it is fed from that one answer for every date. Dated entries
  arrive with slice 5 (regular taxation), which is the first thing that needs them,
  and the meal register is switched over in the same change.
- **Business meals are the register's alone.** A receipt the meal register judges
  goes to the meal line with the register's figure. A vendor rule or a decision
  cannot change it, and the finance screen sends an incomplete meal to
  `/app/meals` instead of offering a form. The statement and the register cannot
  show two different amounts for one meal.
- **Form lines come from the official 2025 form.** Read off the finance ministry's
  letter of 29 August 2025. The 2026 form (letter of 1 September 2026) and the
  employment annex are not compared yet: the app shows those lines by label and
  says the numbers are unverified. Due with slice 7.
- **Hardware lands on the low-value asset line until slice 2.** The category
  "Hardware & IT" defaults to line 36. A laptop or anything else above the limit
  therefore shows there, in full, until the asset register exists or the receipt is
  moved to the depreciation line by hand. The totals are the same either way for
  hardware written off within one year; the line is not.
- **The form source link was a copy** of the ministry's letter on a tax site. It
  has since been replaced by the ministry's own address (see the 2026-10-10 section).
- **Rule sets hold only what slice 1 computes** (form lines, the meal percentage).
  Asset limits, the tariff and the other values enter with the slice that uses
  them, each with its source, so no unverified constant sits in the code.
- **Default line for software is "Arbeitsmittel" (line 51)**, matching how the
  owner filed 2025. The form also has "Laufende EDV-Kosten" (line 50) and
  "Miete/Leasing für bewegliche Wirtschaftsgüter" (line 47, a leased phone); each
  can be chosen per receipt or per vendor.
- **Not computed yet, and said so on the screen:** revenue (slice 4), so no profit
  or loss is shown; regular taxation (slice 5), where receipts are reported instead
  of computed on the wrong basis; payment dates (slice 3), so every receipt counts
  on its document date for now.
- **The local test against the real 2025 file passes**: every claimed amount and
  every line sum of the worked return is reproduced from paid amount and share.
  It pins no fixed total because that file still changes until the return is filed.
- **Found on the way and fixed:** a newly created Receipts table got no company id
  (see the roadmap's completed section).
- **Not verified by a machine, still to do by hand:** the page in the live app
  with the owner's real receipts. Tests cover the service against a real database
  and the screen in a simulated browser, not a deployed build.

## Reality after the first half of slice 2: the asset register (2026-10-07)

Slice 2 is assets and receipt lines. The asset register is built; receipt lines are
not yet.

- **An asset's cost is never typed in.** `TaxAsset` holds what a person states
  (label, kind, date, method, useful life, business share), and `TaxAssetPart`
  links the receipts that make up its cost: the purchase, shipping, customs
  (migration `0011_tax_assets`). The cost is their sum, read on every computation,
  so a corrected receipt moves the whole schedule. A linked receipt is no expense
  of its own. A receipt without an amount makes the cost unknown, not lower.
- **Limits are checked on read, with their sources.** Low-value limit, pool range,
  the one-year life for computer hardware and software, and the declining method
  with its purchase window and caps are values of the rule set (statute text and
  the ministry letter checked on 2026-10-07). An asset whose method its cost does
  not allow contributes nothing and says why. Because limits are net and a small
  business books gross, the limit is decided from the gross amount only where that
  is conclusive; in between the app asks for the net amount.
- **A receipt above the low-value limit can no longer sit on line 36.** It is an
  open check with a button that starts an asset from it. This replaces the
  slice 1 behaviour where a laptop showed on the low-value line.
- **Several small items on one receipt** stay on the low-value line by an explicit
  statement on that receipt. This is the stand-in for receipt lines: once lines
  exist, each line is its own item and the statement is not needed.
- **Schedule rules as built:** equal amounts by month from the month of purchase;
  computer hardware and software in full in the year of purchase; the pool in
  fifths whether or not the asset leaves; declining with the switch to equal
  amounts when those are higher; in the year an asset leaves, depreciation for the
  full months before that month and the rest as remaining book value. Yearly
  amounts are differences of cumulative figures, so they always add up to the cost.
- **Disposal**: sold, scrapped or taken private. Proceeds are revenue on the
  form's line for asset disposals, the only revenue the app computes so far. A
  private withdrawal is treated like a sale at the stated value, with a note that
  the value is a tax advisor's call.
- **Assets from before the app** are entered with their book value on 1 January of
  a year and the months left, without receipts; the old assets held at one euro
  stay there.
- **Business share on an asset** is applied to depreciation, remaining book value
  and proceeds alike. Whether a partly private asset belongs in the register at
  all is a judgment for a tax advisor; the app does not decide it.
- **Found on the way and fixed in slice 1's pull request:** an index name one
  character past what Postgres allows, and a new check in continuous integration
  that the hand-written migrations produce the schema.
- **Not built yet:** receipt lines and the classifier reading them (second half of
  this slice); useful lives from the official tables as a pick list (the owner
  types the years); the asset annex as an export (with the year-end entry sheet,
  slice 7).

## Reality: official form lines per year and per form (2026-10-10)

- **Each year has its own line numbers, listed key by key.** The 2026 form was
  renumbered against 2025 and not by one constant step (goods moved from line 27
  to 29, the other expense lines by one, the revenue lines not at all). The 2026
  numbers were read off the ministry's own file; a test pins every key in both
  years, so a year can never inherit a number from another.
- **Sources are per form.** The income-surplus statement cites the ministry's
  letter of its year; the employment annex of 2025 cites the tax portal's official
  help. The employment annex of 2026 is not compared yet: its two amount lines show
  without a number.
- **Days and distances have no amount line.** The form asks for home-office days
  and for commuting distance, days and transport, not for a euro total. Those two
  employment lines are marked as structured: the app shows their sum for overview
  and never prints a line number for it.
- This closes the slice 1 item "the 2026 line numbers are not yet compared" for the
  income-surplus statement. Open: the employment annex of 2026.

## Decisions (2026-10-07)

Answered by the owner on the decision page on 2026-10-07.

1. **Direction and order of stages**: approved as drafted.
2. **How much to build now**: slices 1 to 4 now, the estimate and the year-end export
   before the 2026 return, stages 2 and 3 after. With decision 10 the regular
   value-added tax mode joins the first build as slice 5.
3. **Bank connection item**: folded into this plan.
4. **Revenue before Books exists**: the minimal invoice list here, replaced by the
   Books tier later. The owner also asked for the state of the Books build in
   framer-clone to be checked so it can be built in parallel; that work has its home
   on the framer-clone roadmap, not here.
5. **Tests with real figures**: a synthetic year in this public repository, the real
   2025 data only as a local test.
6. **Who the app is for**: the owner only, all stages, for now. Offering it to
   customers later is intended; the gates in "Legal boundary" apply then.
7. **Wording of hints**: frank ranking by euro effect, fixed vocabulary, proof
   attached to every hint.
8. **Language model in the advisory layer**: decided after one return with the
   rule-based hints.
9. **What may reach a language model**: totals and business items only, never
   payments classified private, no model on raw bank lines.
10. **Regular value-added taxation**: built in stage 1 (changed from the draft, which
    recommended waiting), together with a forecast that names when a section 19 limit
    will be reached and prepares the owner for the change.
11. **Filing**: the entry sheet, typed into ELSTER with browser assistance for the
    owner's own returns (see "Filing"). The session only saves the draft; the owner
    sends the return himself. Submission through the tax office's software
    interface is planned only once customers use the product.
12. **Mail-in**: yes, as the last slice of stage 1, reading the dedicated expenses
    mailbox that already exists instead of creating a new address.
13. **Session with a tax advisor**: not now; to be decided when the legal form
    question becomes real. Until then the points collected under "what a tax advisor
    should confirm" stay visibly unconfirmed in the app, each on the item or hint it
    concerns.
