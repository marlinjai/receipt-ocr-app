---
title: Receipt OCR App
description: Next.js expense tracking with AI-powered receipt scanning and classification
order: 0
summary: Landing page for Receipt OCR App documentation, a Next.js expense tracking application with AI-powered receipt scanning via Google Cloud Vision and OpenRouter classification.
type: documentation
tags: [receipt-ocr, index, expense-tracking, ai]
projects: [receipt-ocr-app]
---

# Receipt OCR App Documentation

- [Architecture](./architecture) -- System design, data flow, and integrations
- [Getting Started](./getting-started) -- Set up the app locally

## Overview

The Receipt OCR App is a Next.js application for scanning receipts, extracting structured data, and managing expenses with AI assistance. It runs on Cloudflare Workers via `@opennextjs/cloudflare` and uses Google Cloud Vision for OCR, OpenRouter for AI classification and chat, Storage Brain for file storage, and a local `DataBrainAdapter` (pending migration to `adapter-d1` directly — Data Brain archived 2026-03-22) for structured data persistence.

## Key Features

### Upload Pipeline
- Drag-and-drop for images and PDFs
- Three-phase upload flow: uploading, OCR, saving
- Storage Brain SDK for R2 file storage
- Google Cloud Vision OCR (images + PDFs up to 5 pages)

### Field Extraction Engine
A ~500-line heuristic engine (`src/lib/extract-receipt-fields.ts`) extracts structured fields from raw OCR output:

- **Vendor** -- spatial extraction from OCR bounding boxes, with noise filtering
- **Gross / Net** -- multi-pass amount detection supporting European (`1.234,56`) and US (`1,234.56`) number formats
- **Tax Rate** -- extracted directly or derived from gross minus net
- **Date** -- priority-ordered parsing (ISO, EU dot, US slash, named months)
- **Category** -- 3-pass inference: vendor lookup, keyword scan, item-level patterns
- **Konto** -- SKR03 account number derived from category
- **Name** -- composite from vendor, line items, amount, and date

### AI Classification
- LLM-powered classification via OpenRouter (`/api/classify-single`)
- Returns category, SKR03 konto, zuordnung, confidence score, and reasoning
- User-defined classification rules (stored in localStorage) included in prompts
- Default model: `anthropic/claude-sonnet-4-20250514` (configurable via `AI_MODEL` env var)

### AI Chat Sidebar
- 420px slide-in sidebar with streaming SSE responses
- Tool use with human-in-the-loop approval for write operations
- Read-only tools (`get_rows`, `get_columns`, `get_select_options`) execute automatically
- Write tools (`update_cells`, `bulk_update`, `create_row`, `delete_rows`) require user approval
- "Apply All" batch approval for multi-tool responses

### Multi-View Dashboard
- Powered by `@marlinjai/data-table-react` with a local `DataBrainAdapter` (pending migration to adapter-d1)
- 4 views: **Table** (grouped by Category), **By Konto**, **Board** (by Status), **Calendar** (by Date)
- Column management, multi-row selection, search, filter, pagination

### SKR03 Accounting
- 10 German expense categories mapped to SKR03 account numbers (4210--4940)
- Zuordnung options: Universitat, Geschaftlich, Privat

## Quick Start

```bash
pnpm install
cp .env.example .env.local
# Add your API keys to .env.local
pnpm dev
```

## Related Packages

- `@marlinjai/storage-brain-sdk` -- File uploads to Cloudflare R2
- `@marlinjai/data-brain-sdk` -- **Archived 2026-03-22.** Was used by the local DataBrainAdapter; migration to `adapter-d1` pending.
- `@marlinjai/data-table-core` -- Table types, interfaces, base classes
- `@marlinjai/data-table-react` -- React table UI components
