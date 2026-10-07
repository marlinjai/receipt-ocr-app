# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- Asset register in the finance area: an asset is built from the receipts that make up its cost (purchase, shipping, customs) or carried in with its book value; depreciation by method (low-value, pool, equal amounts by month, one year for computer hardware and software, declining) with each limit checked against its legal source; disposal with remaining book value and proceeds; book values per year (migration `0010_tax_assets`)
- A receipt above the low-value asset limit is an open check that leads into a new asset, instead of being expensed at once
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

- A newly created Receipts table carries its company id from the first moment instead of waiting for the backfill script
- A failed text recognition no longer loses the upload: the receipt is saved without text, flagged, for a retake or manual entry
- Supermarket receipts are no longer filed as "Bewirtung" by the fallback rules; the default tax rate for a meal follows the receipt date (19 percent until the end of 2025, 7 percent from 2026)

- Migrated from HTTP API layer to direct D1 adapter (`@marlinjai/data-table-adapter-d1`) for database access
- Classification failures are soft — row saved with Pending status, no upload blocking

### Fixed

- The manifest, its icons, the service worker script and the offline page are public: behind the login they answered with a redirect, so the app could not be installed to the home screen
- The exchange-rate recompute filtered the date column with strings, which the database rejected; it now binds dates

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
