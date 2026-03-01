# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.5.0] - 2026-02-28

### Added

- Liquid Glass UI aesthetic with aurora background, glass-panel surfaces, and backdrop-filter blur
- Direct-to-DB receipt uploads — receipts persist immediately via Data Brain on upload
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

- Receipt-store polling module — replaced by immediate persistence via Data Brain

## [0.4.0] - 2026-02-27

### Added

- Data Brain integration as single persistent storage backend for all environments
- SKR03 accounting categories (Bewirtung, Reisekosten, Bürobedarf, etc.) for German Vorkontierung
- Konto column with SKR03 account numbers
- Notion-style grouping by category/konto in table views
- German vendor and keyword inference maps for category detection

### Changed

- Replaced D1Adapter and MemoryAdapter with DataBrainAdapter as unified data layer

### Fixed

- Exclude clearify.config.ts from TypeScript build check

### Removed

- D1 adapter and memory adapter dependencies
- D1 binding from wrangler deployment config

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
