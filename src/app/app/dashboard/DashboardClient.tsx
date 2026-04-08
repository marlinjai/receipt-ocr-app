'use client';

import { useState, useEffect, useCallback } from 'react';
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
import type { ColumnType, Row, GroupConfig, TextAlignment, CellValue } from '@marlinjai/data-table-core';
import { createServerActionsAdapter } from './server-actions-adapter';
import AiChatSidebar from '@/components/AiChatSidebar';
import ReceiptImagePreview from '@/components/ReceiptImagePreview';
import ReceiptDetailPanel from '@/components/ReceiptDetailPanel';
import { exportCSV } from '@/lib/export-csv';

const dbAdapter = createServerActionsAdapter();

interface DashboardClientProps {
  tableId: string;
  workspaceId: string;
}

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
  const [aiSidebarOpen, setAiSidebarOpen] = useState(false);
  const [detailRow, setDetailRow] = useState<Row | null>(null);
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
            onRowOpen={(row) => setDetailRow(row)}
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
          <div className="flex items-center gap-2">
            <button
              onClick={() => exportCSV({ columns, rows: displayRows })}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium rounded-lg transition-all duration-200"
              style={{
                background: 'var(--surface)',
                color: 'var(--foreground)',
                border: '1px solid var(--border)',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.borderColor = 'rgba(226, 163, 72, 0.4)';
                e.currentTarget.style.color = 'var(--accent)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.borderColor = 'var(--border)';
                e.currentTarget.style.color = 'var(--foreground)';
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
              Export CSV
            </button>
            <button
              onClick={() => setAiSidebarOpen((v) => !v)}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium rounded-lg transition-all duration-200"
              style={{
                background: aiSidebarOpen ? 'var(--accent-muted)' : 'var(--surface)',
                color: aiSidebarOpen ? 'var(--accent)' : 'var(--foreground)',
                border: `1px solid ${aiSidebarOpen ? 'rgba(226, 163, 72, 0.4)' : 'var(--border)'}`,
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.borderColor = 'rgba(226, 163, 72, 0.4)';
                e.currentTarget.style.color = 'var(--accent)';
              }}
              onMouseLeave={(e) => {
                if (!aiSidebarOpen) {
                  e.currentTarget.style.borderColor = 'var(--border)';
                  e.currentTarget.style.color = 'var(--foreground)';
                }
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 3l1.5 3.7 3.8.5-2.8 2.6.7 3.9L12 12l-3.2 1.7.7-3.9-2.8-2.6 3.8-.5z" />
                <path d="M12 3v0M18.4 5.6v0M21 12v0M18.4 18.4v0M12 21v0M5.6 18.4v0M3 12v0M5.6 5.6v0" />
              </svg>
              AI
            </button>
            <Link
              href="/app"
              className="px-4 py-2 text-sm font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-700 transition-colors"
              style={{ boxShadow: '0 0 16px rgba(226, 163, 72, 0.25), 0 0 4px rgba(226, 163, 72, 0.15)' }}
            >
              + Upload Receipt
            </Link>
          </div>
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

      {/* Receipt Image Thumbnails */}
      <ReceiptImagePreview columns={columns} rows={displayRows} />

      {/* Receipt Detail Panel */}
      {detailRow && (
        <ReceiptDetailPanel
          row={detailRow}
          columns={columns}
          selectOptions={selectOptions}
          onClose={() => setDetailRow(null)}
        />
      )}

      {/* AI Chat Sidebar */}
      <AiChatSidebar
        isOpen={aiSidebarOpen}
        onClose={() => setAiSidebarOpen(false)}
        rows={rows}
        columns={columns}
        selectOptions={selectOptions}
        onCellChange={(rowId, columnId, value) => updateCell(rowId, columnId, value)}
        onAddRow={async (cells?: Record<string, CellValue>) => { await addRow({ cells }); }}
        onDeleteRow={deleteRow}
        onCreateSelectOption={(params) => createSelectOption(params.columnId, params.name, params.color)}
        tableId={tableId}
      />
    </div>
  );
}

export default function DashboardClient({ tableId, workspaceId }: DashboardClientProps) {
  return (
    <DataTableProvider dbAdapter={dbAdapter} workspaceId={workspaceId}>
      <DashboardContent tableId={tableId} />
    </DataTableProvider>
  );
}
