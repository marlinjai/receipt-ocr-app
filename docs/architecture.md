---
title: Architecture
description: System design, data flow, and integrations
order: 1
---

# Architecture

This document describes the architecture of the Receipt OCR application.

## System Overview

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
    │  (File Storage + OCR) │   │   (Database + React Table)   │
    └───────────────────────┘   └──────────────────────────────┘
                │                           │
                ▼                           ▼
    ┌───────────────────────┐   ┌──────────────────────────────┐
    │    Cloudflare R2      │   │       Cloudflare D1          │
    │    (File Storage)     │   │       (Database)             │
    └───────────────────────┘   └──────────────────────────────┘
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
Create row in receipts table
      │
      ▼
Redirect to dashboard
```

### Table Flow

```
Dashboard loads
      │
      ▼
useTable hook fetches data
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
D1 database updated
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

### Data Table

```typescript
// components/ReceiptsTable.tsx
import { DataTableProvider, TableView, useTable } from '@marlinjai/data-table-react';
import { D1Adapter } from '@marlinjai/data-table-adapter-d1';

const adapter = new D1Adapter(db);

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

# Database (D1)
DATABASE_URL=...

# Auth (future)
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_...
CLERK_SECRET_KEY=sk_...
```

## Deployment

Target: Cloudflare Pages + Workers

```yaml
# wrangler.toml (for D1 binding)
[[d1_databases]]
binding = "DB"
database_name = "receipt-ocr"
database_id = "..."
```
