---
title: Architecture
description: System design, data flow, and integrations
order: 1
---

# Architecture

This document describes the architecture of the Receipt OCR application.

## System Overview

```
Receipt OCR App (Next.js)
    ├── Storage Brain SDK → Cloudflare R2 (files/OCR)
    └── Data Brain SDK → Data Brain API → Cloudflare D1 (structured data)
```

```
┌─────────────────────────────────────────────────────────────────┐
│                     Receipt OCR App (Next.js)                    │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│   ┌─────────────┐    ┌─────────────┐    ┌─────────────────────┐ │
│   │   Upload    │    │  Dashboard  │    │     API Routes      │ │
│   │   Page      │    │   Page      │    │                     │ │
│   └──────┬──────┘    └──────┬──────┘    └──────────┬──────────┘ │
│          │                  │                       │            │
│          ▼                  ▼                       ▼            │
│   ┌──────────────────────────────────────────────────────────┐  │
│   │                 Component Layer                           │  │
│   │  ┌─────────────────┐  ┌────────────────────────────────┐ │  │
│   │  │ ReceiptUploader │  │ ReceiptsTable (uses data-table)│ │  │
│   │  └────────┬────────┘  └───────────────┬────────────────┘ │  │
│   └───────────┼───────────────────────────┼──────────────────┘  │
│               │                           │                      │
└───────────────┼───────────────────────────┼──────────────────────┘
                │                           │
                ▼                           ▼
    ┌───────────────────────┐   ┌──────────────────────────────┐
    │     Storage Brain     │   │      Data Table Package      │
    │  (File Storage + OCR) │   │   (React Table UI Layer)     │
    └───────────────────────┘   └──────────────────────────────┘
                │                           │
                ▼                           ▼
    ┌───────────────────────┐   ┌──────────────────────────────┐
    │    Cloudflare R2      │   │       Data Brain SDK         │
    │    (File Storage)     │   │   (Structured Data Client)   │
    └───────────────────────┘   └──────────────────────────────┘
                                            │
                                            ▼
                                ┌──────────────────────────────┐
                                │       Data Brain API         │
                                │   (Cloudflare Workers)       │
                                └──────────────────────────────┘
                                            │
                                            ▼
                                ┌──────────────────────────────┐
                                │       Cloudflare D1          │
                                │       (Database)             │
                                └──────────────────────────────┘
```

## Page Structure

### Landing Page (`/`)

Upload interface for new receipts:
- Drag-and-drop zone
- File type validation
- Upload progress indicator
- Redirect to dashboard on success

### Dashboard (`/dashboard`)

Receipts table view:
- Notion-like data table
- Filter bar (vendor, date, category)
- Sort by columns
- Inline editing
- Add/delete rows

## Data Flow

### Upload Flow

```
User drops file
      │
      ▼
Validate file type/size
      │
      ▼
Upload to Storage Brain (context: 'invoice')
      │
      ▼
Storage Brain processes OCR
      │
      ▼
Return file info + OCR data
      │
      ▼
Create row in receipts table via Data Brain
      │
      ▼
Redirect to dashboard
```

### Table Flow

```
Dashboard loads
      │
      ▼
useTable hook fetches data via Data Brain SDK
      │
      ▼
TableView renders rows
      │
      ▼
User edits cell
      │
      ▼
updateCell called
      │
      ▼
Data Brain API updates D1
      │
      ▼
UI re-renders
```

## Integration Points

### Storage Brain SDK

```typescript
// lib/storage.ts
import { StorageBrain } from '@marlinjai/storage-brain-sdk';

export const storage = new StorageBrain({
  apiKey: process.env.STORAGE_BRAIN_API_KEY!,
});

// Usage
const result = await storage.upload(file, {
  context: 'invoice',
  onProgress: (percent) => setProgress(percent),
});
```

### Data Table with Data Brain

```typescript
// components/ReceiptsTable.tsx
import { DataTableProvider, TableView, useTable } from '@marlinjai/data-table-react';
import { DataBrainAdapter } from '@marlinjai/data-table-adapter-data-brain';

const adapter = new DataBrainAdapter({
  baseUrl: process.env.DATA_BRAIN_URL!,
  apiKey: process.env.DATA_BRAIN_API_KEY!,
});

function ReceiptsTable() {
  const { columns, rows, updateCell, addRow } = useTable({ tableId: 'receipts' });

  return (
    <TableView
      columns={columns}
      rows={rows}
      onCellChange={updateCell}
      onAddRow={addRow}
    />
  );
}
```

## Receipt Table Schema

| Column | Type | Description |
|--------|------|-------------|
| `name` | text | Receipt title (primary) |
| `vendor` | text | Merchant name (from OCR) |
| `amount` | number | Total amount (from OCR) |
| `date` | date | Receipt date (from OCR) |
| `category` | select | Expense category |
| `status` | select | Processing status |
| `receipt_image` | file | Original image |
| `ocr_text` | text | Raw OCR text |
| `confidence` | number | OCR confidence % |

## Environment Configuration

```env
# Storage Brain
STORAGE_BRAIN_API_KEY=sk_live_...

# Data Brain
DATA_BRAIN_API_KEY=db_live_...
DATA_BRAIN_URL=https://data-brain.workers.dev

# Auth (future)
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_...
CLERK_SECRET_KEY=sk_...
```

## Deployment

Target: Cloudflare Pages via OpenNext
