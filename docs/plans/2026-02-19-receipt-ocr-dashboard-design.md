---
title: Receipt OCR App — Data Table Dashboard + Clearify Docs
summary: Design document for integrating @marlinjai/data-table-react into the Receipt OCR app as a dashboard page, using in-memory adapter, with Clearify docs setup for three projects.
category: plan
tags: [receipt-ocr, data-table, dashboard, clearify, design]
projects: [receipt-ocr-app, data-table, clearify]
status: active
date: 2026-02-19
---

# Receipt OCR App — Data Table Dashboard + Clearify Docs

**Date:** 2026-02-19
**Status:** Approved

## Summary

Integrate `@marlinjai/data-table-react` into the receipt OCR app as a dashboard page (`/dashboard`), using the in-memory adapter for quick iteration. The existing upload flow (Storage Brain SDK with `context: 'invoice'`) feeds OCR results into the data table. Additionally, set up Clearify documentation in three projects that are missing it.

## Architecture

```
Receipt OCR App (Next.js)
├── / (Landing) — Drag-and-drop upload
│   └── Storage Brain SDK → upload file, context: 'invoice'
│   └── On success → redirect to /dashboard with receipt data
│
├── /dashboard — Data Table with all receipts
│   └── @marlinjai/data-table-react (Table/Board/Calendar views)
│   └── @marlinjai/data-table-adapter-memory (in-memory for now)
│   └── Columns: name, vendor, amount, date, category, status, confidence
│
└── Clearify docs in docs/ folder
```

**Data flow:** Upload receipt → Storage Brain OCR → parse OCR text for vendor/amount/date → create row in data table → show on dashboard.

## Data Table Schema

| Column | Type | Source |
|--------|------|--------|
| `name` | text (primary) | File name |
| `vendor` | text | Parsed from OCR |
| `amount` | number | Parsed from OCR |
| `date` | date | Parsed from OCR |
| `category` | select (Food, Travel, Office, Utilities, Other) | User editable |
| `status` | select (Pending, Processed, Rejected) | Based on OCR result |
| `confidence` | number | From OCR metadata |
| `receipt_image` | url | Storage Brain file URL |
| `ocr_text` | text | Raw OCR full text |

## New Dependencies (receipt-ocr-app)

```
@marlinjai/data-table-react
@marlinjai/data-table-core (peer dep)
@marlinjai/data-table-adapter-memory
```

These will be installed from the local monorepo workspace or npm.

## Clearify Setup (3 projects)

Add `clearify.config.ts` + verify `docs/` folder structure in:
- `projects/receipt-ocr-app/`
- `projects/storage-brain-sdk/`
- `projects/UploadNode/`

Each gets a minimal config pointing to their existing `docs/` folder.

## Out of Scope (YAGNI)

- No D1 persistence yet (in-memory adapter — swap later)
- No auth (Clerk deferred)
- No extending Upload Node with data CRUD endpoints
- No OCR text parsing AI (store raw text, manual edits via table)
- No new column types or data table modifications
