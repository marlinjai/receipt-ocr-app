'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import {
  DataTableProvider,
  useTable,
  useViews,
  TableView,
  BoardView,
  CalendarView,
  ViewSwitcher,
  SearchBar,
  FilterBar,
} from '@marlinjai/data-table-react';
import type { ColumnType, Row, CellValue } from '@marlinjai/data-table-core';
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
    deleteColumn,
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

  // Ingest pending receipts from upload page
  useEffect(() => {
    const statusCol = columns.find((c) => c.name === 'Status');
    const categoryCol = columns.find((c) => c.name === 'Category');
    const selectCols = columns.filter((c) => c.type === 'select' || c.type === 'multi_select');

    const allOptsLoaded = selectCols.every((c) => selectOptions.has(c.id));
    if (columns.length === 0 || !allOptsLoaded) return;

    const ingest = async () => {
      const { receiptStore } = await import('@/lib/receipt-store');
      const { extractReceiptFields } = await import('@/lib/extract-receipt-fields');
      const pending = receiptStore.consumePending();

      for (const { file, ocrResult } of pending) {
        const extracted = ocrResult ? extractReceiptFields(ocrResult) : null;

        const statusOpts = statusCol ? selectOptions.get(statusCol.id) : undefined;
        const statusValue = ocrResult?.fullText
          ? statusOpts?.find((o) => o.name === 'Processed')?.id
          : statusOpts?.find((o) => o.name === 'Pending')?.id;

        const categoryOpts = categoryCol ? selectOptions.get(categoryCol.id) : undefined;
        const categoryValue = extracted?.category
          ? categoryOpts?.find((o) => o.name === extracted.category)?.id ?? null
          : null;

        const cells: Record<string, CellValue> = {};
        for (const col of columns) {
          switch (col.name) {
            case 'Name':
              cells[col.id] = extracted?.name ?? file.originalName;
              break;
            case 'Vendor':
              cells[col.id] = extracted?.vendor ?? null;
              break;
            case 'Gross':
              cells[col.id] = extracted?.gross ?? null;
              break;
            case 'Net':
              cells[col.id] = extracted?.net ?? null;
              break;
            case 'Tax Rate':
              cells[col.id] = extracted?.taxRate ?? null;
              break;
            case 'Date':
              cells[col.id] = extracted?.date ?? null;
              break;
            case 'Category':
              cells[col.id] = categoryValue;
              break;
            case 'Status':
              cells[col.id] = statusValue ?? '';
              break;
            case 'Confidence':
              cells[col.id] = ocrResult?.confidence ? Math.round(ocrResult.confidence * 100) : 0;
              break;
            case 'Receipt Image':
              cells[col.id] = file.url ?? '';
              break;
            case 'OCR Text':
              cells[col.id] = ocrResult?.fullText ?? '';
              break;
          }
        }

        await addRow({ cells });
      }
    };

    ingest();
  }, [columns, selectOptions, addRow]);

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
            {table.name}
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
        onViewChange={(viewId) => setCurrentView(viewId)}
        onCreateView={(type) => createView({ name: type, type })}
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
