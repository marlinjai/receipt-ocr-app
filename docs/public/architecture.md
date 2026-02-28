---
title: Architecture
description: System design, data flow, and integrations
order: 1
---

# Architecture

## System Overview

```
Receipt OCR App (Next.js on Cloudflare Workers)
    ├── Storage Brain SDK  → Cloudflare R2  (file uploads)
    ├── Google Cloud Vision → OCR           (text extraction)
    ├── OpenRouter          → LLM           (classification + chat)
    └── Local DataBrainAdapter → Data Brain API → Cloudflare D1 (structured data)
```

```
┌──────────────────────────────────────────────────────────────────────┐
│                 Receipt OCR App (Next.js / Cloudflare Workers)       │
├──────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  ┌────────────┐  ┌──────────────┐  ┌──────────────┐  ┌───────────┐  │
│  │  Upload    │  │  Dashboard   │  │  AI Chat     │  │   API     │  │
│  │  Page      │  │  (4 views)   │  │  Sidebar     │  │  Routes   │  │
│  └─────┬──────┘  └──────┬───────┘  └──────┬───────┘  └─────┬─────┘  │
│        │                │                  │                │        │
│        ▼                ▼                  ▼                ▼        │
│  ┌───────────────────────────────────────────────────────────────┐   │
│  │                     Component Layer                           │   │
│  │  ┌──────────────┐ ┌─────────────┐ ┌────────────────────────┐ │   │
│  │  │ Receipt      │ │ Data Table  │ │ ChatSidebar            │ │   │
│  │  │ Uploader     │ │ (4 views)   │ │ (SSE + tool approval)  │ │   │
│  │  └──────┬───────┘ └──────┬──────┘ └────────────┬───────────┘ │   │
│  └─────────┼────────────────┼─────────────────────┼─────────────┘   │
│            │                │                     │                  │
└────────────┼────────────────┼─────────────────────┼──────────────────┘
             │                │                     │
      ┌──────┘       ┌───────┘           ┌──────────┘
      ▼              ▼                   ▼
┌───────────┐  ┌───────────────┐  ┌──────────────┐  ┌───────────────┐
│ Storage   │  │ Data Table    │  │ OpenRouter   │  │ Google Cloud  │
│ Brain SDK │  │ React + Local │  │ (LLM API)   │  │ Vision API    │
│           │  │ DataBrain     │  │              │  │ (OCR)         │
│           │  │ Adapter       │  │              │  │               │
└─────┬─────┘  └───────┬───────┘  └──────────────┘  └───────────────┘
      │                │
      ▼                ▼
┌───────────┐  ┌───────────────┐
│ Cloudflare│  │ Data Brain    │
│ R2        │  │ API → D1      │
└───────────┘  └───────────────┘
```

## Page Structure

### Upload Page (`/`)

- Drag-and-drop zone for images and PDFs
- Three-phase progress: uploading, OCR processing, saving
- File type validation (images + PDF)
- Automatic redirect to dashboard on success

### Dashboard (`/dashboard`)

- Powered by `@marlinjai/data-table-react`
- 4 pre-configured views:
  - **Table** -- grouped by Category (default)
  - **By Konto** -- grouped by SKR03 account number
  - **Board** -- Kanban-style board grouped by Status
  - **Calendar** -- date-based view using the Date column
- Column management, multi-row selection, search, filter, pagination
- Inline cell editing
- AI Chat sidebar toggle

## Data Flow

### Upload Flow

```
User drops image or PDF
      │
      ▼
Upload to Storage Brain (R2)
      │
      ▼
POST /api/ocr with fileId
      │
      ▼
Fetch file from Storage Brain → send to Google Cloud Vision API
      │         (images: images:annotate, PDFs: files:annotate up to 5 pages)
      ▼
Return OcrResult { fullText, blocks (with bounding boxes), confidence }
      │
      ▼
extractReceiptFields(ocrResult) — heuristic field extraction
      │   → vendor, gross, net, taxRate, date, category, konto, name
      ▼
POST /api/classify-single (optional AI classification)
      │   → category, konto, zuordnung, confidence, reasoning
      ▼
Create row in receipts table via DataBrainAdapter
      │
      ▼
Redirect to dashboard
```

### AI Chat Flow

```
User opens chat sidebar → types message
      │
      ▼
POST /api/chat (streaming SSE)
      │   system prompt includes: table schema, select options,
      │   SKR03 mappings, zuordnung options, user rules
      ▼
LLM responds with text + optional tool_calls
      │
      ▼
Frontend receives SSE events:
      ├── text_delta → rendered incrementally
      ├── tool_use  → displayed as pending action
      │       │
      │       ├── read-only tool (get_rows, get_columns, get_select_options)
      │       │       → auto-executed, result sent back as tool_result
      │       │
      │       └── write tool (update_cells, bulk_update, create_row, delete_rows)
      │               → requires user approval ("Apply" / "Apply All")
      │               → on approval: executed client-side, result sent back
      │
      └── done → response complete
```

## Field Extraction Engine

Located at `src/lib/extract-receipt-fields.ts` (~500 lines). Returns an `ExtractionResult` with `name`, `vendor`, `gross`, `net`, `taxRate`, `date`, `category`, and `konto`.

### Amount Extraction (multi-pass)
1. **Net**: looks for lines matching subtotal/netto/before-tax labels
2. **Tax**: looks for tax/VAT/MwSt labels (excluding total lines)
3. **Gross** (4 passes):
   - High-priority: "grand total", "amount due", "balance due"
   - Medium-priority: generic "total" (excluding subtotal/tax lines)
   - EU keywords: "gesamt", "summe", "brutto"
   - Fallback: largest amount found anywhere in the text
4. **Derivation**: if 2 of 3 values are found, the third is calculated

### Vendor Extraction
- Primary: spatial extraction from OCR bounding boxes (topmost non-noise block)
- Fallback: first non-noise line in the first 8 lines of OCR text
- Noise filter: skips pure numbers, addresses, metadata labels, generic headings

### Date Extraction
- Priority: labeled dates ("Date:", "Invoice Date:") first
- Formats: ISO (`2024-01-15`), EU dot (`15.01.2024`), US slash (`01/15/2024`), named months (`Jan 15, 2024`)
- Skips expiry/card dates

### Category Inference (3-pass)
1. **Vendor lookup**: matches vendor name against ~80 known vendors (e.g., "starbucks" -> Bewirtung)
2. **Keyword scan**: matches full OCR text against category keyword patterns
3. **Item patterns**: checks for specific line-item hints (e.g., "cappuccino" -> Bewirtung)
4. Falls back to "Sonstige Ausgaben" if no match

## Local DataBrainAdapter

The app uses a **local** `DataBrainAdapter` at `src/lib/data-brain-adapter.ts` (not imported from the npm package `@marlinjai/data-table-adapter-data-brain`). It extends `BaseDatabaseAdapter` from `@marlinjai/data-table-core` and delegates all calls to a `DataBrain` SDK client.

```typescript
// src/lib/data-brain-adapter.ts
import { BaseDatabaseAdapter } from '@marlinjai/data-table-core';
import { DataBrain } from '@marlinjai/data-brain-sdk';

export class DataBrainAdapter extends BaseDatabaseAdapter {
  private readonly client: DataBrain;
  constructor(config: { baseUrl: string; apiKey: string; workspaceId?: string }) {
    super();
    this.client = new DataBrain({ apiKey: config.apiKey, baseUrl: config.baseUrl });
  }
  // ... delegates ~30 methods to this.client
}
```

## Receipt Table Schema

| Column | Type | Description |
|--------|------|-------------|
| `Name` | text | Composite summary (primary column) |
| `Vendor` | text | Merchant name (OCR spatial extraction) |
| `Gross` | number | Total amount incl. tax |
| `Net` | number | Amount before tax |
| `Tax Rate` | number | Tax percentage (e.g. 19 for 19%) |
| `Date` | date | Receipt date (ISO 8601) |
| `Category` | select | SKR03 expense category (10 options) |
| `Konto` | text | SKR03 account number (e.g. "4650") |
| `Status` | select | Pending / Processed / Rejected |
| `Confidence` | number | OCR or AI classification confidence |
| `Receipt Image` | url | Link to original file in Storage Brain |
| `OCR Text` | text | Raw OCR text for AI context |
| `Zuordnung` | select | Dynamic column: Universitat / Geschaftlich / Privat |

### SKR03 Category-to-Konto Mapping

| Category | Konto |
|----------|-------|
| Bewirtung | 4650 |
| Reisekosten | 4670 |
| Burobedarf | 4930 |
| Software & Lizenzen | 4806 |
| Telefon & Internet | 4920 |
| Hardware & IT | 4855 |
| Miete & Nebenkosten | 4210 |
| Versicherungen | 4360 |
| Fachliteratur | 4940 |
| Sonstige Ausgaben | 4900 |

## API Routes

| Route | Method | Purpose |
|-------|--------|---------|
| `/api/ocr` | POST | Fetches file from Storage Brain, sends to Google Cloud Vision, returns `OcrResult` |
| `/api/classify-single` | POST | LLM classification of a single receipt via OpenRouter |
| `/api/chat` | POST | Streaming AI chat with tool use (SSE) |
| `/api/files/[fileId]` | GET | Proxies file downloads from Storage Brain |

## Environment Configuration

```env
# Storage Brain (file uploads to R2)
NEXT_PUBLIC_STORAGE_BRAIN_API_KEY=sk_live_...
NEXT_PUBLIC_STORAGE_BRAIN_URL=https://storage-brain-api.marlin-pohl.workers.dev

# Data Brain (structured data persistence)
NEXT_PUBLIC_DATA_BRAIN_API_KEY=db_live_...
NEXT_PUBLIC_DATA_BRAIN_URL=https://data-brain.workers.dev

# Google Cloud Vision (OCR)
GOOGLE_CLOUD_VISION_API_KEY=AIza...

# OpenRouter (AI classification + chat)
OPENROUTER_API_KEY=sk-or-v1-...

# Optional: override AI models
# AI_MODEL=anthropic/claude-sonnet-4-20250514
# AI_CLASSIFY_MODEL=anthropic/claude-sonnet-4-20250514
```

## Deployment

**Target**: Cloudflare Workers via `@opennextjs/cloudflare`

The app is deployed at `receipts.lumitra.co`. Server-side secrets (`GOOGLE_CLOUD_VISION_API_KEY`, `OPENROUTER_API_KEY`) are configured as Cloudflare Workers secrets. Client-side env vars use the `NEXT_PUBLIC_` prefix.
