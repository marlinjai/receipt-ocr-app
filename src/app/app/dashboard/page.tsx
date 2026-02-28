'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
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
import type { ColumnType, Row, GroupConfig, TextAlignment } from '@marlinjai/data-table-core';
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
  const [selectedRows, setSelectedRows] = useState<Set<string>>(new Set());
  const displayRows = searchResults ?? rows;

  // Delete selected rows on Backspace/Delete key
  const handleDeleteSelected = useCallback(() => {
    if (selectedRows.size === 0) return;
    selectedRows.forEach((id) => deleteRow(id));
    setSelectedRows(new Set());
  }, [selectedRows, deleteRow]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (selectedRows.size === 0) return;
      // Don't trigger if user is typing in an input/textarea
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement).isContentEditable) return;
      if (e.key === 'Backspace' || e.key === 'Delete') {
        e.preventDefault();
        handleDeleteSelected();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [selectedRows, handleDeleteSelected]);

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
            onColumnAlignmentChange={(columnId, alignment: TextAlignment) => updateColumn(columnId, { alignment })}
            enableKeyboardNav
            onAddProperty={(name, type: ColumnType) => addColumn({ name, type })}
            onCreateSelectOption={createSelectOption}
            onUpdateSelectOption={updateSelectOption}
            onDeleteSelectOption={deleteSelectOption}
            onUploadFile={uploadFile}
            onDeleteFile={deleteFile}
            selectedRows={selectedRows}
            onSelectionChange={setSelectedRows}
            sorts={sorts}
            onSortChange={setSorts}
            isLoading={isRowsLoading}
            hasMore={hasMore}
            onLoadMore={loadMore}
            groupConfig={currentView?.config?.groupConfig as GroupConfig | undefined}
            onGroupConfigChange={(config) => {
              if (currentView) {
                updateView(currentView.id, {
                  config: { ...currentView.config, groupConfig: config },
                });
              }
            }}
          />
        );
    }
  };

  return (
    <div
      className="h-screen flex flex-col"
      data-theme="dark"
      onClick={(e) => {
        // Clicking dead space (background, header, toolbar) refocuses the table for keyboard nav
        const tag = (e.target as HTMLElement).tagName;
        if (tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'BUTTON' && tag !== 'SELECT' && tag !== 'A' && !(e.target as HTMLElement).isContentEditable) {
          const tableView = document.querySelector('.dt-table-view') as HTMLElement | null;
          tableView?.focus();
        }
      }}
    >
      {/* Header */}
      <div className="px-6 pt-6 pb-2" style={{ background: 'rgba(10, 10, 15, 0.4)' }}>
        <div className="flex items-center justify-between mb-1">
          <h1 className="text-2xl font-bold" style={{ color: 'var(--dt-text-primary)' }}>
            {table.name}
          </h1>
          <Link
            href="/app"
            className="px-4 py-2 text-sm font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-700 transition-colors"
            style={{ boxShadow: '0 0 16px rgba(226, 163, 72, 0.25), 0 0 4px rgba(226, 163, 72, 0.15)' }}
          >
            + Upload Receipt
          </Link>
        </div>
        <div className="flex items-center gap-3">
          <p className="text-sm" style={{ color: 'var(--dt-text-secondary)' }}>
            {rows.length} items · {columns.length} properties
          </p>
          {selectedRows.size > 0 && (
            <button
              onClick={handleDeleteSelected}
              className="inline-flex items-center gap-1.5 px-3 py-1 text-xs font-medium rounded-md transition-all duration-150"
              style={{
                background: 'rgba(239, 68, 68, 0.12)',
                color: '#f87171',
                border: '1px solid rgba(239, 68, 68, 0.2)',
              }}
              onMouseEnter={e => {
                e.currentTarget.style.background = 'rgba(239, 68, 68, 0.2)';
                e.currentTarget.style.borderColor = 'rgba(239, 68, 68, 0.35)';
              }}
              onMouseLeave={e => {
                e.currentTarget.style.background = 'rgba(239, 68, 68, 0.12)';
                e.currentTarget.style.borderColor = 'rgba(239, 68, 68, 0.2)';
              }}
            >
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="2 4 14 4" />
                <path d="M5.5 4V2.5a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1V4" />
                <path d="M3.5 4l.7 9.1a1 1 0 0 0 1 .9h5.6a1 1 0 0 0 1-.9L12.5 4" />
              </svg>
              {selectedRows.size} selected
            </button>
          )}
        </div>
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
      <div className="px-4 py-2 flex gap-2 items-center" style={{ borderBottom: '1px solid var(--dt-border-color)', background: 'rgba(10, 10, 15, 0.3)' }}>
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
      <div className="flex-1 overflow-auto p-4">
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
