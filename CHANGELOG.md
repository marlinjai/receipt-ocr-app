# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- Moving a workspace to another company, the receipts side: the signed endpoint `POST /api/internal/workspace-move` restamps the company on every row of one workspace (the tables are read from the Prisma data model, so a new one cannot be forgotten) and moves the contacts its meals name as guests to the target company under the same ids, with `@marlinjai/contacts-core` 0.3.0. A dry run reports the counts and writes nothing; anything that cannot move cleanly blocks the whole apply; a repeat finishes a move that stopped half way; the same call with the companies swapped is the rollback. Own secret `WORKSPACE_MOVE_SECRET`, refused without it. How to call it: `docs/operations/workspace-move.md`
- A receipt with two tax rates says so: a new column "Tax Rates" next to "Tax Rate" shows every rate the receipt carries ("7 % + 19 %", the one that carries most of the bill first), and the receipt's detail panel shows the same. The number column keeps the main rate for sorting and filtering. The text follows every change of the rate or the tax lines (reading, a new reading, the meal form, an edit in the table, an import). Receipts already stored get their text when the column is created, read again from their stored text where they print two rates
- The ten-day rule at the turn of the year: payments between 22 December and 10 January are listed in a tab "Jahreswechsel" with the rule and its source; a regularly recurring one (rent, insurance, an advance payment of value-added tax) can be confirmed to count in the year it belongs to. Nothing is moved without an answer, and the answer belongs to the payment day (migration `0016_tax_year_boundary`)
- Payments can be linked by hand to any receipt of the year or the year before, or to an invoice with something open, with a part of the amount; a payment without a name can be marked private; re-labelled payments are listed and can be put back; refunds ask for their receipt
- Receipt lines in the finance area: a receipt can be split into positions that add up to its total, each treated on its own (one business, one private; one an asset, one expensed at once); a line can have its own decision or follow its receipt, and an asset can be built from single lines (migration `0015_tax_receipt_lines`)
- Review list: a receipt stored by the old reader gets a new reading of its stored text, shown as "stored / newly read" per field (name, vendor, total, net, tax rate, tip, category) and written only when taken. No model is asked. "Geprüft, stimmt so" keeps what is stored
- Review list "Belege prüfen" on the dashboard: receipts that need a look, with the reasons in plain words (not readable, amount or date missing, impossible tax figures, not classified, total not confirmed, possible duplicate) and the actions "Beleg öffnen", "Geprüft, stimmt so", "Beide behalten" and "Löschen". Worked out from the stored receipts on every load, so a warning no longer depends on the upload page that first showed it (migration `0014_receipt_reviews`, additive)
- Business-meal register: the current year is always offered, the register opens on the newest year that has a meal, and meals without a date are counted instead of being invisible
- Payments in the finance area: accounts, import of export files (N26, Tomorrow and PayPal as CSV, the bank interface's transaction list as JSON), read whole or not at all and idempotent across overlapping files; one answer per counterparty (business, private, own account); links from payments to receipts and issued invoices, made automatically only on an invoice number in the payment text with the exact amount, otherwise proposed and confirmed by a person; a linked payment gives a receipt its payment day and the euro amount actually charged (migration `0013_tax_payments`)
- Revenue in the finance area: a list of issued invoices with their payments; revenue counts on the day the money arrived, an unpaid invoice is shown as outstanding, and profit or loss is shown once invoices are recorded (migration `0012_tax_revenue_vat`)
- Forecast of the small-business limits (25,000 euros for the previous year, 100,000 for the running year, both by money received): a range to year end, the month a limit would be passed, and a preparation list for the change to regular taxation
- Regular value-added taxation: the status is a first answer plus dated changes, and every receipt, invoice and asset is judged by the status on its own date; under regular taxation costs count net, the tax is input tax at the business share, invoices carry output tax; advance return periods (monthly or quarterly, by issue or by payment date) and payments to the tax office
- Asset register in the finance area: an asset is built from the receipts that make up its cost (purchase, shipping, customs) or carried in with its book value; depreciation by method (low-value, pool, equal amounts by month, one year for computer hardware and software, declining) with each limit checked against its legal source; disposal with remaining book value and proceeds; book values per year (migration `0011_tax_assets`)
- A receipt above the low-value asset limit is an open check that leads into a new asset, instead of being expensed at once
- Verified production database recovery: six-hourly backups, 30 days of off-server copies, an isolated restoration verifier, and a recovery runbook.
- Finance area at `/app/finance`: the income-surplus statement (Einnahmenüberschussrechnung, EÜR) computed from the receipts, line by line with the receipts behind each line; a queue of open checks for receipts that still need a decision; a list of vendor rules
- Shares for several purposes per receipt (for example 50 percent business plus 30 percent study), decided per receipt or once per vendor from a date on; the business part goes to the statement, the study and employment part to the employment annex (migration `0009_tax_decisions`: `tax_item_decisions`, `tax_vendor_rules`)
- Tax module `src/lib/tax`: one `computeYear` over integer cents, rule sets per year with a source and check date for every legal value; form lines of 2025 read off the official form
- Business-meal register (Bewirtungsverzeichnis) at `/app/meals`: meal type, guests from a contact list, occasion, place, tip and host per receipt; completeness and the 70 percent deductible amount derived on read; a queue of incomplete meals; a per-year register with export as CSV (comma-separated values) and PDF (Portable Document Format, summary plus one sheet per meal with the receipt and a signature line)
- One question per workspace decides the base of the 70 percent: small business under section 19 of the value-added tax act (gross) or not (net); no amounts or exports until it is answered
- Contact list behind a `ContactStore` interface (migration `0008_meal_register`: `contacts`, `meal_guests`, `workspace_tax_settings`)
- Upload: the same file is recognised by its content hash before anything is uploaded; a receipt photographed twice gets a warning with "keep both" or "discard"; multi-page scans can be split into one receipt per page
- `pnpm test:db`: database-backed tests against a throwaway Postgres (requires `TEST_DATABASE_URL`)
- Phone capture on the upload page: a camera button, one photo at a time, no redirect; a business meal is followed by the question for guests and occasion; a badly read photo can be retaken onto the same receipt
- Photos are scaled to 2000 pixels and converted to JPEG in the browser before upload (also in the batch uploader)
- Offline capture queue in the browser: photos taken without a connection, on a lost connection or with an expired session are kept and sent later, visibly counted
- Service worker that caches no application code: it only serves a self-contained offline page when a navigation fails, with a server-side kill switch (`DISABLE_SERVICE_WORKER`)
- Share target (Android): a file shared to the installed app is processed like a photo taken there
- Classifier reads meal type, eaten in or taken away, tip, tax lines and the restaurant address; continuous integration now runs typecheck, lint, unit tests and the database tests
- Multi-receipt batch upload with queue UI — select multiple files at once, sequential processing with per-file progress indicators (uploading, OCR, classifying, done/error), overall X/Y progress counter
- Failed files show per-file errors without blocking other uploads

### Changed

- The meal register and the meal form follow the value-added tax status on each meal's own date when the status changed inside a year
- The limit forecast no longer counts invoices that were unpaid at the end of a finished year as that year's turnover, and measures open invoices without the tax in them
- Every year in which an invoice, a payment, a tax settlement or a status change is dated can be selected in the finance area
- Lines the app computes itself (input tax, tax paid to the tax office) can no longer be chosen for a receipt by hand; a carried-in asset with a book value but no remaining life is reported instead of silently never being written off; a failed action is shown on every tab
- A newly created Receipts table carries its company id from the first moment instead of waiting for the backfill script
- A failed text recognition no longer loses the upload: the receipt is saved without text, flagged, for a retake or manual entry
- Supermarket receipts are no longer filed as "Bewirtung" by the fallback rules; the default tax rate for a meal follows the receipt date (19 percent until the end of 2025, 7 percent from 2026)

- Migrated from HTTP API layer to direct D1 adapter (`@marlinjai/data-table-adapter-d1`) for database access
- Classification failures are soft — row saved with Pending status, no upload blocking

### Fixed

- A refund linked to a receipt whose purchase is not linked counted the receipt as zero; it is now taken off the receipt's own amount. A payment received through PayPal in another currency was read as a refund; it is income
- Payments, from an independent review of the first version: a link to an invoice never counts more than the invoice has open and never money going out; an import and its automatic links happen together or not at all, and two imports or two confirmations at the same moment cannot store or use a payment twice; an import is undone newest first; an account stays with one source; an automatic link is judged against every unlinked payment, not only the new file's; amounts in a notation that cannot be read for certain ("1,234.56", "1.234") are refused; a PayPal purchase in another currency is the euro amount actually paid, under the purchase's name
- Receipt reading: the classifier had never run in production (it asked for an Anthropic key that is not set there, and the error was swallowed), so every receipt was filed by pattern matching alone. It now runs through the OpenRouter key production has, uses a valid model name and the current web search tool when a direct key exists, and a missing or failed classification is recorded on the receipt
- Receipt reading: a receipt number was read as the total (916,752.88 instead of 58.70) and tax amounts as the net (rates of 526 and 844 percent). Total, net and tax now come from the tax groups the receipt prints and are confirmed by its own arithmetic; a printed tip is split off the total; a total only a label vouches for is put up for a look; nothing is guessed from the largest number
- Receipt reading: the vendor was the first printed line (a slogan, an item extra, one word of a three-line name). Slogans, item lines, contact lines and misread logos are no longer names, a name set in several lines is joined, and a cropped head gives no name instead of a wrong one
- Receipt reading: a bar was filed as software and a taverna as "other". A table, a waiter, a tip line or the printed hospitality form now make a restaurant receipt, and vendor names in the category list match as whole words only
- Receipt reading: the receipt date depended on the server's time zone (a receipt of the 9th became the 8th at 23:00 UTC outside UTC)
- A page nothing could be read from was saved as an empty row named "Receipt". It is now named "Nicht lesbar: <file>" and stands in the review list
- Deleting a receipt in the dashboard removed the row and left its stored file behind. It now deletes the stored file first and keeps the receipt complete, with a message, when the file store refuses; a file another receipt still shows is kept
- The dashboard deleted the selected receipts on Backspace without asking. It now asks first, in the page, and says what was deleted and what was kept
- The manifest, its icons, the service worker script and the offline page are public: behind the login they answered with a redirect, so the app could not be installed to the home screen
- The exchange-rate recompute filtered the date column with strings, which the database rejected; it now binds dates
- A saved occasion, place or host of a business meal read back empty while the page said "Gespeichert": two page loads had each created the meal columns, so the table held them twice, the save wrote one and the read took the other. Readers and writers now resolve a column name the same way, the next page load folds a doubled column back into one (every value is moved over first; a column holding a differing value is renamed, never deleted), and the columns are created under a per-workspace lock so two requests cannot both create one
- After a column was added to or removed from a table while the app was running, saves could fail with "row not found" until the next restart: Postgres refuses a prepared `SELECT *` once the table's shape changed. The database client no longer keeps prepared statements

## [0.5.0] - 2026-02-28

### Added

- Liquid Glass UI aesthetic with aurora background, glass-panel surfaces, and backdrop-filter blur
- Direct-to-DB receipt uploads — receipts persist immediately on upload
- Row selection with backspace/delete keyboard deletion
- Column alignment and keyboard navigation (arrow keys, Tab)
- Improved receipt name extraction with 3 item detection patterns (price-based, quantity-based, SKU-based)
- Broader German/English noise filtering and deduplication for receipt parsing

### Changed

- Bumped data-table packages to ^0.2.0 for liquid glass UI and keyboard nav support

### Fixed

- Refocus table on background click to restore keyboard navigation
- Single-click cell editing and show ungrouped rows (data-table-react 0.1.3)

### Removed

- Receipt-store polling module — replaced by immediate database persistence

## [0.4.0] - 2026-02-27

### Added

- Database integration as persistent storage backend for all environments
- SKR03 accounting categories (Bewirtung, Reisekosten, Bürobedarf, etc.) for German Vorkontierung
- Konto column with SKR03 account numbers
- Notion-style grouping by category/konto in table views
- German vendor and keyword inference maps for category detection

### Fixed

- Exclude clearify.config.ts from TypeScript build check

## [0.3.0] - 2026-02-20

### Added

- Server-side OCR API route using Google Cloud Vision
- Two-phase upload flow — Storage Brain upload then OCR via Vision API
- D1 adapter support with memory fallback for local dev
- OpenNext Cloudflare deployment configuration with D1 binding
- Storage Brain SDK workspace support (v0.5.0) with automatic workspace scoping
- Marketing landing page with hero, features, and how-it-works sections
- Custom domain route for receipts.lumitra.co
- Deployment to Cloudflare Workers

### Changed

- Moved upload page from `/` to `/app`, dashboard from `/dashboard` to `/app/dashboard`
- Replaced file: links with published npm packages (data-table v0.1.x)
- Decoupled OCR types from Storage Brain SDK into app-owned types

### Fixed

- Turbopack CSS import panic for file-linked packages
- Turbopack dev compatibility with dist/ CSS import path
- Updated storage-brain-sdk to v0.4.0, removed deprecated OcrResult type

## [0.2.0] - 2026-02-19

### Added

- Dashboard page with Data Table integration (Table, Board, Calendar views)
- Receipts table initialization with schema and views
- Upload-to-dashboard flow with receipt data ingestion
- Intelligent receipt field extraction pipeline (vendor, amount, date, category)
- Regex/heuristic parsing for US and European number/date formats
- Spatial vendor detection from OCR blocks
- Keyword-based category inference against ~50 known vendors

## [0.1.0] - 2026-01-11

### Added

- Initial Next.js application setup
- Drag & drop receipt upload component with progress tracking
- OCR result display with confidence score and copy functionality
- File preview for images and placeholder for PDFs
- Storage Brain SDK integration for file uploads with invoice OCR context
- File details panel with status indicators
