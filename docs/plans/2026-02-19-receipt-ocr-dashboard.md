---
title: Receipt OCR Dashboard Implementation Plan
summary: Step-by-step implementation plan for integrating data-table-react into the Receipt OCR app with in-memory adapter and adding Clearify documentation to three projects.
type: plan
tags: [receipt-ocr, data-table, implementation, clearify]
projects: [receipt-ocr-app, data-table, clearify]
status: draft
date: 2026-02-19
---

# Receipt OCR Dashboard Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Integrate @marlinjai/data-table-react into the receipt OCR app as a /dashboard page with in-memory adapter, and add Clearify documentation configs to 3 projects.

**Architecture:** The receipt OCR app (Next.js) gets a new /dashboard route powered by the data-table component. Uploads on the landing page flow through Storage Brain SDK for OCR, then create a row in the in-memory data table. The dashboard displays receipts in Table/Board/Calendar views.

**Tech Stack:** Next.js 16, React 19, @marlinjai/data-table-react, @marlinjai/data-table-adapter-memory, @marlinjai/storage-brain-sdk, Tailwind CSS 4, Clearify

---

### Task 1: Install data-table packages in receipt-ocr-app

**Files:**
- Modify: `/Users/marlinjai/software dev/ERP-suite/projects/receipt-ocr-app/package.json`

**Step 1: Install packages**

Run:
```bash
cd "/Users/marlinjai/software dev/ERP-suite/projects/receipt-ocr-app"
npm install @marlinjai/data-table-core @marlinjai/data-table-react @marlinjai/data-table-adapter-memory
```

If packages are not on npm, install from local paths:
```bash
npm install "file:../data-table/packages/core" "file:../data-table/packages/react" "file:../data-table/packages/adapter-memory"
```

**Step 2: Verify install**

Run: `cd "/Users/marlinjai/software dev/ERP-suite/projects/receipt-ocr-app" && node -e "require('@marlinjai/data-table-react')"`
Expected: No errors

**Step 3: Commit**

```bash
cd "/Users/marlinjai/software dev/ERP-suite/projects/receipt-ocr-app"
git add package.json package-lock.json
git commit -m "feat: add data-table packages as dependencies"
```

---

### Task 2: Create receipts table initialization module

**Files:**
- Create: `/Users/marlinjai/software dev/ERP-suite/projects/receipt-ocr-app/src/lib/receipts-table.ts`

**Step 1: Create the module**

This module initializes the in-memory adapter and creates the receipts table with the defined schema. It exports a singleton so the same adapter/table is shared across components.

```typescript
import { MemoryAdapter } from '@marlinjai/data-table-adapter-memory';
import type { ColumnType } from '@marlinjai/data-table-core';

const WORKSPACE_ID = 'receipt-ocr';
const TABLE_NAME = 'Receipts';

const RECEIPT_COLUMNS: Array<{ name: string; type: ColumnType; isPrimary?: boolean }> = [
  { name: 'Name', type: 'text', isPrimary: true },
  { name: 'Vendor', type: 'text' },
  { name: 'Amount', type: 'number' },
  { name: 'Date', type: 'date' },
  { name: 'Category', type: 'select' },
  { name: 'Status', type: 'select' },
  { name: 'Confidence', type: 'number' },
  { name: 'Receipt Image', type: 'url' },
  { name: 'OCR Text', type: 'text' },
];

const CATEGORY_OPTIONS = ['Food', 'Travel', 'Office', 'Utilities', 'Entertainment', 'Other'];
const CATEGORY_COLORS = ['#ef4444', '#3b82f6', '#f59e0b', '#10b981', '#8b5cf6', '#6b7280'];

const STATUS_OPTIONS = ['Pending', 'Processed', 'Rejected'];
const STATUS_COLORS = ['#f59e0b', '#10b981', '#ef4444'];

export const dbAdapter = new MemoryAdapter();

let initPromise: Promise<string> | null = null;

export function getReceiptsTableId(): Promise<string> {
  if (!initPromise) {
    initPromise = initializeTable();
  }
  return initPromise;
}

async function initializeTable(): Promise<string> {
  const table = await dbAdapter.createTable({
    workspaceId: WORKSPACE_ID,
    name: TABLE_NAME,
  });

  const columnIds: Record<string, string> = {};

  for (const col of RECEIPT_COLUMNS) {
    const column = await dbAdapter.createColumn({
      tableId: table.id,
      name: col.name,
      type: col.type,
      isPrimary: col.isPrimary,
    });
    columnIds[col.name] = column.id;
  }

  // Create select options for Category
  const categoryColId = columnIds['Category'];
  for (let i = 0; i < CATEGORY_OPTIONS.length; i++) {
    await dbAdapter.createSelectOption({
      columnId: categoryColId,
      name: CATEGORY_OPTIONS[i],
      color: CATEGORY_COLORS[i],
    });
  }

  // Create select options for Status
  const statusColId = columnIds['Status'];
  for (let i = 0; i < STATUS_OPTIONS.length; i++) {
    await dbAdapter.createSelectOption({
      columnId: statusColId,
      name: STATUS_OPTIONS[i],
      color: STATUS_COLORS[i],
    });
  }

  // Create default views
  await dbAdapter.createView({
    tableId: table.id,
    name: 'Table',
    type: 'table',
    isDefault: true,
  });

  await dbAdapter.createView({
    tableId: table.id,
    name: 'Board',
    type: 'board',
    config: { groupBy: statusColId },
  });

  await dbAdapter.createView({
    tableId: table.id,
    name: 'Calendar',
    type: 'calendar',
    config: { calendarConfig: { dateColumnId: columnIds['Date'] } },
  });

  return table.id;
}

export { WORKSPACE_ID };
```

**Step 2: Commit**

```bash
cd "/Users/marlinjai/software dev/ERP-suite/projects/receipt-ocr-app"
git add src/lib/receipts-table.ts
git commit -m "feat: add receipts table initialization with schema and views"
```

---

### Task 3: Create Dashboard page

**Files:**
- Create: `/Users/marlinjai/software dev/ERP-suite/projects/receipt-ocr-app/src/app/dashboard/page.tsx`
- Modify: `/Users/marlinjai/software dev/ERP-suite/projects/receipt-ocr-app/src/app/globals.css`

**Step 1: Import data-table styles in globals.css**

Add at the top of `src/app/globals.css`, after the tailwind import:

```css
@import "@marlinjai/data-table-react/dist/styles/variables.css";
@import "@marlinjai/data-table-react/dist/styles/components.css";
```

Note: If the CSS imports fail at build time, copy the CSS files from `node_modules/@marlinjai/data-table-react/dist/styles/` into `src/styles/` and import from there instead.

**Step 2: Create the dashboard page**

```tsx
'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { DataTableProvider, useTable, useViews, TableView, BoardView, CalendarView, ViewSwitcher, SearchBar, FilterBar } from '@marlinjai/data-table-react';
import type { ColumnType, Row } from '@marlinjai/data-table-core';
import { dbAdapter, getReceiptsTableId, WORKSPACE_ID } from '@/lib/receipts-table';

function DashboardContent({ tableId }: { tableId: string }) {
  const {
    table,
    columns,
    rows,
    selectOptions,
    updateCell,
    addRow,
    deleteRow,
    addColumn,
    updateColumn,
    createSelectOption,
    updateSelectOption,
    deleteSelectOption,
    uploadFile,
    deleteFile,
    filters,
    sorts,
    setFilters,
    setSorts,
    hasMore,
    loadMore,
    isRowsLoading,
    loadSelectOptions,
  } = useTable({ tableId });

  const {
    views,
    currentView,
    createView,
    updateView,
    deleteView,
    setCurrentView,
  } = useViews({ tableId });

  const [searchResults, setSearchResults] = useState<Row[] | null>(null);
  const displayRows = searchResults ?? rows;

  // Load select options for all select columns
  useEffect(() => {
    columns
      .filter((c) => c.type === 'select' || c.type === 'multi_select')
      .forEach((c) => loadSelectOptions(c.id));
  }, [columns, loadSelectOptions]);

  if (!table) return <div className="p-8 text-center text-gray-500">Loading table...</div>;

  const statusColumn = columns.find((c) => c.name === 'Status');
  const dateColumn = columns.find((c) => c.name === 'Date');

  const renderView = () => {
    switch (currentView?.type) {
      case 'board':
        return (
          <BoardView
            columns={columns}
            rows={displayRows}
            selectOptions={selectOptions}
            config={{
              groupByColumnId: statusColumn?.id ?? '',
              showEmptyGroups: true,
            }}
            onCellChange={(rowId, columnId, value) => updateCell(rowId, columnId, value)}
            onAddRow={(cells) => addRow({ cells })}
            onDeleteRow={deleteRow}
            onCreateSelectOption={createSelectOption}
            onUpdateSelectOption={updateSelectOption}
            onDeleteSelectOption={deleteSelectOption}
            onUploadFile={uploadFile}
            onDeleteFile={deleteFile}
          />
        );
      case 'calendar':
        return (
          <CalendarView
            columns={columns}
            rows={displayRows}
            config={{ dateColumnId: dateColumn?.id ?? '' }}
          />
        );
      default:
        return (
          <TableView
            columns={columns}
            rows={displayRows}
            selectOptions={selectOptions}
            onCellChange={(rowId, columnId, value) => updateCell(rowId, columnId, value)}
            onAddRow={() => addRow()}
            onDeleteRow={deleteRow}
            onColumnResize={(columnId, width) => updateColumn(columnId, { width })}
            onAddProperty={(name, type: ColumnType) => addColumn({ name, type })}
            onCreateSelectOption={createSelectOption}
            onUpdateSelectOption={updateSelectOption}
            onDeleteSelectOption={deleteSelectOption}
            onUploadFile={uploadFile}
            onDeleteFile={deleteFile}
            sorts={sorts}
            onSortChange={setSorts}
            isLoading={isRowsLoading}
            hasMore={hasMore}
            onLoadMore={loadMore}
          />
        );
    }
  };

  return (
    <div className="h-screen flex flex-col bg-[var(--dt-bg-primary)]" data-theme="dark">
      {/* Header */}
      <div className="px-6 pt-6 pb-2">
        <div className="flex items-center justify-between mb-1">
          <h1 className="text-2xl font-bold" style={{ color: 'var(--dt-text-primary)' }}>
            🧾 {table.name}
          </h1>
          <Link
            href="/"
            className="px-4 py-2 text-sm font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-700 transition-colors"
          >
            + Upload Receipt
          </Link>
        </div>
        <p className="text-sm" style={{ color: 'var(--dt-text-secondary)' }}>
          {rows.length} items · {columns.length} properties
        </p>
      </div>

      {/* View Switcher */}
      <ViewSwitcher
        views={views}
        currentViewId={currentView?.id ?? null}
        onViewChange={(viewId) => {
          const view = views.find((v) => v.id === viewId);
          if (view) setCurrentView(view);
        }}
        onCreateView={(type) => createView({ tableId, name: type, type })}
        onDeleteView={deleteView}
        onRenameView={(viewId, name) => updateView(viewId, { name })}
      />

      {/* Search & Filter */}
      <div className="px-4 py-2 flex gap-2 items-center" style={{ borderBottom: '1px solid var(--dt-border-color)' }}>
        <SearchBar
          rows={rows}
          columns={columns}
          onSearchResults={(results, term) => setSearchResults(term ? results : null)}
        />
        <FilterBar
          columns={columns}
          filters={filters}
          selectOptions={selectOptions}
          onFiltersChange={setFilters}
        />
      </div>

      {/* Table/Board/Calendar */}
      <div className="flex-1 overflow-auto">
        {renderView()}
      </div>
    </div>
  );
}

export default function DashboardPage() {
  const [tableId, setTableId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getReceiptsTableId()
      .then(setTableId)
      .catch((err) => setError(err.message));
  }, []);

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-red-600 text-center">
          <p className="text-lg font-medium">Failed to initialize table</p>
          <p className="text-sm mt-2">{error}</p>
        </div>
      </div>
    );
  }

  if (!tableId) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p className="text-gray-500">Initializing receipts table...</p>
      </div>
    );
  }

  return (
    <DataTableProvider dbAdapter={dbAdapter} workspaceId={WORKSPACE_ID}>
      <DashboardContent tableId={tableId} />
    </DataTableProvider>
  );
}
```

**Step 3: Verify dev server runs**

Run: `cd "/Users/marlinjai/software dev/ERP-suite/projects/receipt-ocr-app" && npm run dev`

Visit http://localhost:3000/dashboard — should show empty receipts table with view switcher.

**Step 4: Commit**

```bash
cd "/Users/marlinjai/software dev/ERP-suite/projects/receipt-ocr-app"
git add src/app/dashboard/page.tsx src/app/globals.css
git commit -m "feat: add dashboard page with data table integration"
```

---

### Task 4: Wire upload flow to dashboard

**Files:**
- Modify: `/Users/marlinjai/software dev/ERP-suite/projects/receipt-ocr-app/src/app/page.tsx`
- Create: `/Users/marlinjai/software dev/ERP-suite/projects/receipt-ocr-app/src/lib/receipt-store.ts`

**Step 1: Create a simple receipt store for cross-page data passing**

Since we're using in-memory state (no server persistence), we need a way to pass upload results from the landing page to the dashboard. A simple event-based store works.

```typescript
// src/lib/receipt-store.ts
import type { FileInfo } from '@/lib/storage';

type Listener = (receipt: FileInfo) => void;

const listeners = new Set<Listener>();
const pendingReceipts: FileInfo[] = [];

export const receiptStore = {
  addReceipt(receipt: FileInfo) {
    pendingReceipts.push(receipt);
    listeners.forEach((fn) => fn(receipt));
  },

  consumePending(): FileInfo[] {
    return pendingReceipts.splice(0);
  },

  subscribe(fn: Listener): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};
```

**Step 2: Modify landing page to redirect to dashboard after upload**

Replace the `Home` component in `src/app/page.tsx`. Key changes:
- On upload complete, store the receipt in `receiptStore` and redirect to `/dashboard`
- Add a link to the dashboard

In `src/app/page.tsx`, replace the `Home` function:

```tsx
'use client';

import { useCallback } from 'react';
import { useRouter } from 'next/navigation';
import ReceiptUploader from '@/components/ReceiptUploader';
import { receiptStore } from '@/lib/receipt-store';
import type { FileInfo } from '@/lib/storage';
import Link from 'next/link';

export default function Home() {
  const router = useRouter();

  const handleUploadComplete = useCallback((file: FileInfo) => {
    receiptStore.addReceipt(file);
    router.push('/dashboard');
  }, [router]);

  return (
    <main className="min-h-screen py-12 px-4">
      <div className="max-w-4xl mx-auto">
        {/* Header */}
        <div className="text-center mb-12">
          <h1 className="text-4xl font-bold text-gray-900 mb-4">
            Receipt OCR
          </h1>
          <p className="text-lg text-gray-600 max-w-2xl mx-auto">
            Upload receipts and invoices to instantly extract text using AI-powered OCR.
            Powered by{' '}
            <a
              href="https://github.com/marlinjai/storage-brain"
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-600 hover:underline"
            >
              Storage Brain
            </a>
            .
          </p>
          <Link
            href="/dashboard"
            className="inline-block mt-4 px-4 py-2 text-sm font-medium text-blue-600 bg-blue-50 rounded-lg hover:bg-blue-100 transition-colors"
          >
            View Dashboard →
          </Link>
        </div>

        {/* Upload */}
        <ReceiptUploader onUploadComplete={handleUploadComplete} />

        {/* Footer */}
        <footer className="mt-16 text-center text-sm text-gray-500">
          <p>
            Built with{' '}
            <a
              href="https://www.npmjs.com/package/@marlinjai/storage-brain-sdk"
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-600 hover:underline"
            >
              @marlinjai/storage-brain-sdk
            </a>
          </p>
        </footer>
      </div>
    </main>
  );
}
```

**Step 3: Add receipt ingestion to dashboard**

Add a `useEffect` in `DashboardContent` (in `src/app/dashboard/page.tsx`) that consumes pending receipts and creates rows:

Add this inside the `DashboardContent` component, after the existing hooks:

```typescript
// Ingest pending receipts from upload page
useEffect(() => {
  const ingest = async () => {
    const { receiptStore } = await import('@/lib/receipt-store');
    const pending = receiptStore.consumePending();

    for (const file of pending) {
      const ocrData = file.metadata?.ocrData;
      const statusCol = columns.find((c) => c.name === 'Status');
      const statusOptions = statusCol ? selectOptions.get(statusCol.id) : undefined;

      const statusValue = ocrData?.fullText
        ? statusOptions?.find((o) => o.name === 'Processed')?.id
        : statusOptions?.find((o) => o.name === 'Pending')?.id;

      const cells: Record<string, unknown> = {};
      for (const col of columns) {
        switch (col.name) {
          case 'Name':
            cells[col.id] = file.originalName;
            break;
          case 'Vendor':
            cells[col.id] = '';
            break;
          case 'Amount':
            cells[col.id] = 0;
            break;
          case 'Date':
            cells[col.id] = new Date().toISOString();
            break;
          case 'Status':
            cells[col.id] = statusValue ?? '';
            break;
          case 'Confidence':
            cells[col.id] = ocrData?.confidence ? Math.round(ocrData.confidence * 100) : 0;
            break;
          case 'Receipt Image':
            cells[col.id] = file.url ?? '';
            break;
          case 'OCR Text':
            cells[col.id] = ocrData?.fullText ?? '';
            break;
        }
      }

      await addRow({ cells });
    }
  };

  if (columns.length > 0) {
    ingest();
  }
}, [columns, selectOptions, addRow]);
```

**Step 4: Test the full flow**

1. Run: `cd "/Users/marlinjai/software dev/ERP-suite/projects/receipt-ocr-app" && npm run dev`
2. Visit http://localhost:3000
3. Upload a receipt image
4. Verify redirect to /dashboard with the new row visible
5. Switch between Table/Board/Calendar views

**Step 5: Commit**

```bash
cd "/Users/marlinjai/software dev/ERP-suite/projects/receipt-ocr-app"
git add src/lib/receipt-store.ts src/app/page.tsx src/app/dashboard/page.tsx
git commit -m "feat: wire upload flow to dashboard with receipt ingestion"
```

---

### Task 5: Add Clearify config to receipt-ocr-app

**Files:**
- Create: `/Users/marlinjai/software dev/ERP-suite/projects/receipt-ocr-app/clearify.config.ts`

**Step 1: Install Clearify**

```bash
cd "/Users/marlinjai/software dev/ERP-suite/projects/receipt-ocr-app"
npm install --save-dev @marlinjai/clearify
```

**Step 2: Create clearify.config.ts**

```typescript
import { defineConfig } from 'clearify';

export default defineConfig({
  name: 'Receipt OCR App',
});
```

**Step 3: Verify docs render**

```bash
cd "/Users/marlinjai/software dev/ERP-suite/projects/receipt-ocr-app"
npx clearify dev
```

Visit http://localhost:4747 — should render docs/index.md and docs/architecture.md.

**Step 4: Commit**

```bash
cd "/Users/marlinjai/software dev/ERP-suite/projects/receipt-ocr-app"
git add clearify.config.ts package.json package-lock.json
git commit -m "feat: add Clearify documentation config"
```

---

### Task 6: Add Clearify config to storage-brain-sdk

**Files:**
- Create: `/Users/marlinjai/software dev/ERP-suite/projects/storage-brain-sdk/clearify.config.ts`

**Step 1: Install Clearify**

```bash
cd "/Users/marlinjai/software dev/ERP-suite/projects/storage-brain-sdk"
npm install --save-dev @marlinjai/clearify
```

**Step 2: Create clearify.config.ts**

```typescript
import { defineConfig } from 'clearify';

export default defineConfig({
  name: 'Storage Brain SDK',
});
```

**Step 3: Add CHANGELOG.md**

```markdown
# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.3.0] - 2026-02-10

### Added
- Node.js support with fetch-based uploads
- Full TypeScript types for all API responses
- Retry logic with exponential backoff
- AbortSignal support for cancellation

## [0.2.0] - 2026-01-15

### Added
- Upload progress tracking via XMLHttpRequest
- Quota and tenant info endpoints

## [0.1.0] - 2026-01-11

### Added
- Initial release
- StorageBrain client class
- File upload, get, list, delete operations
- OCR processing with context: 'invoice'
```

**Step 4: Verify**

```bash
cd "/Users/marlinjai/software dev/ERP-suite/projects/storage-brain-sdk"
npx clearify dev
```

**Step 5: Commit**

```bash
cd "/Users/marlinjai/software dev/ERP-suite/projects/storage-brain-sdk"
git add clearify.config.ts CHANGELOG.md package.json
git commit -m "feat: add Clearify documentation config and CHANGELOG"
```

---

### Task 7: Add Clearify config to UploadNode

**Files:**
- Create: `/Users/marlinjai/software dev/ERP-suite/projects/UploadNode/clearify.config.ts`

**Step 1: Install Clearify**

```bash
cd "/Users/marlinjai/software dev/ERP-suite/projects/UploadNode"
npm install --save-dev @marlinjai/clearify
```

**Step 2: Create clearify.config.ts**

```typescript
import { defineConfig } from 'clearify';

export default defineConfig({
  name: 'Storage Brain (Upload Node)',
});
```

**Step 3: Add CHANGELOG.md**

```markdown
# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.1.0] - 2026-01-11

### Added
- Initial release
- Cloudflare Worker API with Hono
- Multi-tenant authentication with API keys
- File upload via presigned URLs to R2
- OCR processing via Google Cloud Vision
- Thumbnail generation (placeholder)
- Quota management per tenant
- Webhook notifications
- Admin endpoints for tenant management
```

**Step 4: Verify**

```bash
cd "/Users/marlinjai/software dev/ERP-suite/projects/UploadNode"
npx clearify dev
```

**Step 5: Commit**

```bash
cd "/Users/marlinjai/software dev/ERP-suite/projects/UploadNode"
git add clearify.config.ts CHANGELOG.md package.json
git commit -m "feat: add Clearify documentation config and CHANGELOG"
```

---

## Execution Summary

| Task | What | Estimated Complexity |
|------|------|---------------------|
| 1 | Install data-table packages | Simple |
| 2 | Create receipts-table init module | Medium |
| 3 | Create dashboard page | Medium-Large |
| 4 | Wire upload → dashboard flow | Medium |
| 5 | Clearify for receipt-ocr-app | Simple |
| 6 | Clearify for storage-brain-sdk | Simple |
| 7 | Clearify for UploadNode | Simple |

**Parallelization:** Tasks 5-7 (Clearify) are fully independent of Tasks 1-4 (dashboard) and can run in parallel.
