---
title: Receipt OCR App Overhaul — Design Document
summary: Design document for overhauling the Receipt OCR app after Storage Brain v0.4.0 breaking changes, adding Google Cloud Vision OCR, D1 persistence, and Cloudflare Pages deployment via OpenNext.
type: plan
tags: [receipt-ocr, design, ocr, cloudflare, google-cloud-vision]
projects: [receipt-ocr-app, storage-brain]
status: superseded
date: 2026-02-20
---

# Receipt OCR App Overhaul — Design Document

**Date:** 2026-02-20
**Status:** Approved
**Scope:** Fix Storage Brain v0.4.0 compatibility, add server-side OCR, D1 persistence, Cloudflare Pages deployment

---

## Problem Statement

Storage Brain v0.4.0 removed all server-side processing (OCR, thumbnails, context-aware processing). The Receipt OCR app currently depends on `result.metadata.ocrData` from Storage Brain uploads — this no longer exists. Additionally, the app uses in-memory storage (data lost on refresh) and is deployed to Vercel instead of the target Cloudflare ecosystem.

## Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| OCR Provider | Google Cloud Vision API | Best accuracy for receipts, structured text extraction, 1000 free/month |
| OCR Location | Server-side Next.js API route | Keeps API keys secure, handles large images server-side |
| Persistence | Cloudflare D1 via data-table adapter | Fits ERP suite architecture, persistent SQL |
| Deployment | Cloudflare Pages via OpenNext | Best Next.js 16 compatibility, supports server components + D1 bindings |

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                   Cloudflare Pages                       │
│  ┌──────────────────┐  ┌──────────────────────────────┐ │
│  │   Next.js App     │  │   API Routes (Workers)       │ │
│  │                   │  │                              │ │
│  │  / (upload page)  │  │  POST /api/ocr               │ │
│  │  /dashboard       │  │    → Google Cloud Vision      │ │
│  │                   │  │    → extractReceiptFields()   │ │
│  │  Components:      │  │    → Insert row into D1      │ │
│  │  - ReceiptUploader│  │                              │ │
│  │  - DataTable      │  │  GET /api/receipts           │ │
│  │                   │  │    → List from D1            │ │
│  └──────────────────┘  └──────────────────────────────┘ │
│                                                          │
│  ┌──────────────────┐  ┌──────────────────────────────┐ │
│  │  Cloudflare D1    │  │  Storage Brain (R2)          │ │
│  │  (receipts data)  │  │  (receipt images)            │ │
│  └──────────────────┘  └──────────────────────────────┘ │
└─────────────────────────────────────────────────────────┘
         │                          │
         │                          │
    ┌────▼────┐              ┌──────▼──────┐
    │  D1     │              │ Storage     │
    │ Adapter │              │ Brain SDK   │
    │ (data-  │              │ v0.4.0      │
    │ table)  │              └─────────────┘
    └─────────┘
```

## Data Flow

### Upload + OCR Flow

1. User drops receipt image on upload zone
2. `ReceiptUploader` calls `storage.upload(file, { context: 'receipt', tags: { source: 'receipt-ocr-app' } })`
3. Storage Brain uploads to R2, returns `{ id, url, originalName, ... }` with `processingStatus: 'completed'`
4. Client calls `POST /api/ocr` with `{ fileUrl, fileId, originalName }`
5. API route fetches image from `fileUrl`
6. Sends image to Google Cloud Vision `DOCUMENT_TEXT_DETECTION`
7. Vision returns text annotations with bounding boxes + confidence
8. `extractReceiptFields()` parses: vendor, gross, net, taxRate, date, category, name
9. API route inserts row into D1 via data-table adapter
10. Returns extracted data to client
11. Client navigates to `/dashboard` — data is persistent

### Dashboard Flow

1. Dashboard mounts, data-table fetches rows from D1 via adapter
2. Rows include all receipt fields + image URL + OCR text
3. User can edit, filter, sort, switch views (table/board/calendar)
4. Changes persist in D1

## Changes Required

### 1. Storage Brain Integration (SDK v0.4.0 compat)

**File: `src/lib/storage.ts`**
- Keep `getStorageClient()` factory
- Remove `OcrResult` type import (no longer exists in SDK)
- Update type imports to match v0.4.0

**File: `src/components/ReceiptUploader.tsx`**
- Remove dependency on `result.metadata.ocrData`
- After upload succeeds, call `/api/ocr` endpoint instead
- Show OCR processing status separately from upload status

### 2. New OCR API Route

**File: `src/app/api/ocr/route.ts`** (new)
- `POST` handler accepts `{ fileUrl, fileId, originalName }`
- Fetches image from Storage Brain URL
- Calls Google Cloud Vision `DOCUMENT_TEXT_DETECTION`
- Runs `extractReceiptFields()` on Vision response
- Inserts receipt row into D1 via data-table adapter
- Returns extracted fields

**Environment variables:**
- `GOOGLE_CLOUD_VISION_API_KEY` — Vision API key

### 3. Update Field Extraction

**File: `src/lib/extract-receipt-fields.ts`**
- Adapt to accept Google Cloud Vision response format
- Vision returns `textAnnotations[]` and `fullTextAnnotation`
- Map Vision blocks to existing `OcrBlock` format expected by extraction logic

### 4. D1 Persistence

**File: `src/lib/receipts-table.ts`**
- Replace `MemoryAdapter` with `D1Adapter`
- D1 binding configured via `wrangler.toml`
- Table schema stays the same (11 columns)

**File: `src/lib/receipt-store.ts`**
- Simplify or remove event-based pending queue (no longer needed since OCR + insert happens server-side in one step)

### 5. Cloudflare Pages Deployment

**New files:**
- `wrangler.toml` — Pages config with D1 binding
- `open-next.config.ts` — OpenNext configuration

**Changes:**
- Install `@opennextjs/cloudflare`
- Add build script: `opennextjs-cloudflare`
- Configure D1 database binding
- Set environment variables (Storage Brain API key, Google Vision API key)

### 6. Remove Vercel Config

- Remove `.vercel/` directory
- Update deployment references in docs

## Environment Variables

| Variable | Purpose | Where |
|----------|---------|-------|
| `NEXT_PUBLIC_STORAGE_BRAIN_API_KEY` | Storage Brain SDK auth | Client + Server |
| `NEXT_PUBLIC_STORAGE_BRAIN_URL` | Storage Brain base URL | Client + Server |
| `GOOGLE_CLOUD_VISION_API_KEY` | Google Cloud Vision OCR | Server only |

## Testing Strategy

- Existing `extractReceiptFields()` tests should pass (input format adapter)
- Manual test: upload receipt → verify OCR extraction → verify D1 persistence
- Verify Cloudflare Pages build + deploy

## Out of Scope

- Authentication/user accounts
- Multi-tenant support
- Receipt export (CSV/PDF)
- Mobile-specific UI
