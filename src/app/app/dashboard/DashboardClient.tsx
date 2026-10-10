'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
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
import type { Column, ColumnType, Row, GroupConfig, FooterConfig, SubItemsConfig, TextAlignment, CellValue } from '@marlinjai/data-table-core';
import { createServerActionsAdapter } from './server-actions-adapter';
import { deleteReceiptsForGood } from './actions';
import { confirmReceiptChecked, getReviewQueue, keepBothLookAlikes, takeNewReading, type ReviewActionError, type ReviewResult } from './review-actions';
import FxRecomputePanel from './FxRecomputePanel';
import BulkEditBar from './BulkEditBar';
import GroupBar from './GroupBar';
import GroupPanel from './GroupPanel';
import { createReceiptGroup, moveReceiptsIntoGroup, removeReceiptsFromGroup, type GroupActionError, type GroupResult } from './group-actions';
import AiChatSidebar from '@/components/AiChatSidebar';
import ReceiptDetailPanel from '@/components/ReceiptDetailPanel';
import ReviewPanel from '@/components/review/ReviewPanel';
import ConfirmDialog from '@/components/ui/ConfirmDialog';
import type { ReviewEntry } from '@/lib/review/service';
import { PresignedStorageBrainAdapter } from '@/lib/presigned-file-adapter';
import { exportCSV } from '@/lib/export-csv';
import { isGroupRow, receiptsOnly, visibleColumns } from '@/lib/receipts-kind';
import { deleteWording, deletedWording, groupCellValue, groupsOf, receiptsInGroup, searchWithGroupReceipts, selectionKinds } from '@/lib/groups/view';

const dbAdapter = createServerActionsAdapter();
const fileAdapter = new PresignedStorageBrainAdapter();

interface DashboardClientProps {
  tableId: string;
  workspaceId: string;
  /** Business meals that still lack guests or occasion (see /app/meals). */
  openMealCount: number;
  /** Receipts that need a look, as loaded with the page. Null when loading them failed. */
  initialReview: ReviewEntry[] | null;
}

const REVIEW_ERROR: Record<ReviewActionError, string> = {
  unauthorized: 'Die Sitzung ist abgelaufen. Bitte neu anmelden.',
  forbidden: 'Dafür fehlt die Berechtigung.',
  not_found: 'Der Beleg wurde nicht gefunden. Die Liste wurde neu geladen.',
  not_initialized: 'Die Belegtabelle ist noch nicht eingerichtet.',
  failed: 'Das hat nicht geklappt. Es wurde nichts geändert.',
};

const GROUP_ERROR: Record<GroupActionError, string> = {
  unauthorized: 'Die Sitzung ist abgelaufen. Bitte neu anmelden.',
  forbidden: 'Dafür fehlt die Berechtigung.',
  failed: 'Das hat nicht geklappt. Es wurde nichts geändert.',
  not_initialized: 'Die Belegtabelle ist noch nicht für Gruppen eingerichtet. Bitte die Seite neu laden.',
  group_not_found: 'Die Gruppe gibt es nicht mehr. Die Ansicht wurde neu geladen.',
  row_not_found: 'Ein Beleg wurde nicht gefunden. Es wurde nichts verschoben, die Ansicht wurde neu geladen.',
  group_in_group: 'Eine Gruppe kann nicht in einer Gruppe liegen. Bitte nur Belege auswählen.',
  invalid_name: 'Bitte einen Namen mit höchstens 120 Zeichen eingeben.',
  not_writable: 'Eine Gruppe hat nur ihren Namen und ihre Zuordnung. Beträge und Dateien stehen auf den Belegen.',
};

function receipts(n: number): string {
  return n === 1 ? '1 Beleg' : `${n} Belege`;
}

function DashboardContent({ tableId, openMealCount, initialReview }: { tableId: string; openMealCount: number; initialReview: ReviewEntry[] | null }) {
  const {
    table,
    columns,
    rows,
    selectOptions,
    updateCell,
    addRow,
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
    refresh,
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
  // The keyboard-focused row (Notion-style implicit selection): bulk edits
  // apply to it when nothing is checkbox-selected. Destructive actions
  // (delete) intentionally still require an explicit selection.
  const [activeRowId, setActiveRowId] = useState<string | null>(null);
  const [aiSidebarOpen, setAiSidebarOpen] = useState(false);
  const [detailRow, setDetailRow] = useState<Row | null>(null);
  const [groupPanelId, setGroupPanelId] = useState<string | null>(null);
  // A search that finds a group shows the group's receipts with it (see `searchWithGroupReceipts`).
  const displayRows = useMemo(
    () => (searchResults ? searchWithGroupReceipts(searchResults, rows, columns) : rows),
    [searchResults, rows, columns],
  );

  // A group is a row that holds receipts and is never one itself (see
  // `lib/receipts-kind.ts`). The table draws groups; everything that counts,
  // edits in bulk, exports or hands rows to the assistant works on receipts.
  // The column that says which rows are groups is not shown or edited.
  const tableColumns = useMemo(() => visibleColumns(columns), [columns]);
  const receiptRows = useMemo(() => receiptsOnly(rows, columns), [rows, columns]);
  const displayReceiptRows = useMemo(() => receiptsOnly(displayRows, columns), [displayRows, columns]);
  const groups = useMemo(() => groupsOf(rows, columns), [rows, columns]);
  const selection = useMemo(() => selectionKinds(selectedRows, rows, columns), [selectedRows, rows, columns]);
  const isCountedRow = useCallback((row: Row) => !isGroupRow(row, columns), [columns]);
  const groupSummary = useCallback(
    (row: Row, children: Row[], column: Column) => groupCellValue(row, children, column, columns),
    [columns],
  );

  // Deleting is for good (stored file, row, guests, tax decision), so it is
  // always asked first, in the page, and its outcome is said in the page.
  const [pendingDelete, setPendingDelete] = useState<string[] | null>(null);
  // Of the rows about to be deleted, the groups: they are dissolved (their receipts stay), which the question has to say.
  const pendingGroupIds = useMemo(
    () => new Set(selectionKinds(pendingDelete ?? [], rows, columns).groupIds),
    [pendingDelete, rows, columns],
  );
  const pendingWording = useMemo(() => {
    const ids = new Set(pendingDelete ?? []);
    const leftBehind = [...pendingGroupIds].flatMap((id) => receiptsInGroup(id, rows, columns)).filter((r) => !ids.has(r.id)).length;
    return deleteWording(ids.size - pendingGroupIds.size, pendingGroupIds.size, leftBehind);
  }, [pendingDelete, pendingGroupIds, rows, columns]);
  const [working, setWorking] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'warn' | 'danger'; text: string } | null>(null);
  const [review, setReview] = useState<ReviewEntry[]>(initialReview ?? []);
  const [reviewError, setReviewError] = useState<string | null>(
    initialReview === null ? 'Die Prüfliste konnte nicht geladen werden. Die Belege unten sind vollständig.' : null,
  );

  const requestDelete = useCallback((rowIds: string[]) => {
    const ids = [...new Set(rowIds)];
    if (ids.length > 0) setPendingDelete(ids);
  }, []);

  const applyReview = useCallback((result: ReviewResult<ReviewEntry[]>) => {
    if (result.ok) {
      setReview(result.value);
      setReviewError(null);
    } else {
      setReviewError(REVIEW_ERROR[result.error]);
    }
  }, []);

  const reloadReview = useCallback(async () => {
    try {
      applyReview(await getReviewQueue());
    } catch {
      setReviewError(REVIEW_ERROR.failed);
    }
  }, [applyReview]);

  const runReviewAction = useCallback(
    async (action: () => Promise<ReviewResult<ReviewEntry[]>>) => {
      if (working) return;
      setWorking(true);
      try {
        const result = await action();
        if (result.ok) {
          applyReview(result);
        } else {
          // The receipt behind a failed action may be gone: show what is there now,
          // THEN say what failed. The other way round the reload cleared the message
          // and the person never learned that the action did not happen.
          await reloadReview();
          setReviewError(REVIEW_ERROR[result.error]);
        }
      } catch {
        setReviewError(REVIEW_ERROR.failed);
      } finally {
        setWorking(false);
      }
    },
    [working, applyReview, reloadReview],
  );

  const confirmDelete = useCallback(async () => {
    if (!pendingDelete || working) return;
    setWorking(true);
    try {
      const outcome = await deleteReceiptsForGood(pendingDelete);
      const gone = new Set(outcome.deleted);
      setSelectedRows((current) => new Set([...current].filter((id) => !gone.has(id))));
      setDetailRow((current) => (current && gone.has(current.id) ? null : current));
      // The list drops them at once; the reload below then brings what the server says.
      setReview((list) =>
        list
          .filter((entry) => !gone.has(entry.rowId))
          .map((entry) => ({ ...entry, duplicates: entry.duplicates.filter((d) => !gone.has(d.rowId)) })),
      );
      setGroupPanelId((current) => (current && gone.has(current) ? null : current));
      const fileKept = outcome.kept.filter((k) => k.reason === 'file_delete_failed').length;
      const failed = outcome.kept.filter((k) => k.reason === 'failed').length;
      const parts: string[] = [];
      // A group is dissolved, not deleted as a receipt, and the notice says which was which.
      const goneGroups = outcome.deleted.filter((id) => pendingGroupIds.has(id)).length;
      const done = deletedWording(outcome.deleted.length - goneGroups, goneGroups);
      if (done) parts.push(done);
      if (fileKept > 0) parts.push(`${receipts(fileKept)} behalten: Die gespeicherte Datei ließ sich nicht löschen. Bitte später noch einmal versuchen.`);
      if (failed > 0) parts.push(`${receipts(failed)} behalten: Das Löschen ist fehlgeschlagen.`);
      if (parts.length === 0) parts.push('Die Belege waren schon gelöscht.');
      setNotice({ tone: fileKept + failed > 0 ? 'warn' : 'ok', text: parts.join(' ') });
    } catch {
      setNotice({ tone: 'danger', text: 'Das Löschen ist fehlgeschlagen. Es wurde nichts gelöscht, was nicht oben als gelöscht steht.' });
    } finally {
      setPendingDelete(null);
      setWorking(false);
      // The delete is done and said above. If the table cannot be reloaded now, say that
      // too: the rows shown may be out of date until the page is loaded again.
      try {
        await Promise.all([refresh(), reloadReview()]);
      } catch {
        setReviewError('Die Ansicht konnte nicht neu geladen werden. Bitte die Seite neu laden.');
      }
    }
  }, [pendingDelete, pendingGroupIds, working, refresh, reloadReview]);

  // --- Groups ---

  // What a group action did is said in the page; the rows are loaded again
  // either way, because a refusal usually means the view was out of date.
  const runGroupAction = useCallback(
    async <T,>(action: () => Promise<GroupResult<T>>, done: (value: T) => string): Promise<boolean> => {
      if (working) return false;
      setWorking(true);
      let ok = false;
      try {
        const result = await action();
        ok = result.ok;
        setNotice(result.ok ? { tone: 'ok', text: done(result.value) } : { tone: 'danger', text: GROUP_ERROR[result.error] });
      } catch {
        setNotice({ tone: 'danger', text: GROUP_ERROR.failed });
      } finally {
        setWorking(false);
        try {
          await refresh();
        } catch {
          setReviewError('Die Ansicht konnte nicht neu geladen werden. Bitte die Seite neu laden.');
        }
      }
      return ok;
    },
    [working, refresh],
  );

  const createGroup = useCallback(
    async (name: string) => {
      const members = selection.receiptIds;
      const ok = await runGroupAction(
        () => createReceiptGroup(name, members),
        () => (members.length > 0 ? `Gruppe angelegt, ${receipts(members.length)} hineingelegt.` : 'Leere Gruppe angelegt.'),
      );
      if (ok) setSelectedRows(new Set());
      return ok;
    },
    [selection.receiptIds, runGroupAction],
  );

  const moveIntoGroup = useCallback(
    async (groupId: string, rowIds: string[]) => {
      const ok = await runGroupAction(
        () => moveReceiptsIntoGroup(groupId, rowIds),
        ({ moved }) => (moved === 0 ? 'Die Belege liegen schon in dieser Gruppe.' : `${receipts(moved)} in die Gruppe gelegt.`),
      );
      if (ok) setSelectedRows(new Set());
    },
    [runGroupAction],
  );

  const takeOutOfGroup = useCallback(
    async (rowIds: string[]) => {
      await runGroupAction(
        () => removeReceiptsFromGroup(rowIds),
        ({ moved }) => (moved === 0 ? 'Die Belege liegen in keiner Gruppe.' : `${receipts(moved)} aus der Gruppe genommen.`),
      );
    },
    [runGroupAction],
  );

  // A cell edit the server refuses (an amount typed onto a group through another
  // path, a lost session) must not look saved: say so and show what is stored.
  const saveCell = useCallback(
    (rowId: string, columnId: string, value: CellValue) => {
      updateCell(rowId, columnId, value).catch(() => {
        setNotice({ tone: 'danger', text: 'Die Änderung wurde nicht gespeichert. Die Tabelle zeigt wieder den gespeicherten Stand.' });
        void refresh().catch(() => setReviewError('Die Ansicht konnte nicht neu geladen werden. Bitte die Seite neu laden.'));
      });
    },
    [updateCell, refresh],
  );

  // Which groups are folded is kept with the view, like its folded sections, so a reload shows the same table.
  const subItemsConfig = useMemo<SubItemsConfig>(
    () => ({ enabled: true, collapsedParents: (currentView?.config?.subItemsConfig as SubItemsConfig | undefined)?.collapsedParents ?? [] }),
    [currentView?.config?.subItemsConfig],
  );
  const setGroupFolded = useCallback(
    (rowId: string, folded: boolean) => {
      if (!currentView) return;
      const before = subItemsConfig.collapsedParents ?? [];
      const collapsedParents = folded ? [...new Set([...before, rowId])] : before.filter((id) => id !== rowId);
      void updateView(currentView.id, { config: { ...currentView.config, subItemsConfig: { enabled: true, collapsedParents } } }).catch(() =>
        setNotice({ tone: 'warn', text: 'Die Ansicht konnte nicht gespeichert werden. Nach dem Neuladen sind die Gruppen wieder wie zuvor auf- oder zugeklappt.' }),
      );
    },
    [currentView, subItemsConfig, updateView],
  );

  // Delete selected rows on Backspace/Delete key
  const handleDeleteSelected = useCallback(() => {
    if (selectedRows.size === 0) return;
    requestDelete([...selectedRows]);
  }, [selectedRows, requestDelete]);
  const deleteOne = useCallback((rowId: string) => requestDelete([rowId]), [requestDelete]);

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

  // The ledger always shows every receipt: sums, groups and the review of a year are
  // wrong on a partial list. The table loads in pages, so the next page is fetched as
  // soon as the previous one has arrived, until nothing is left.
  useEffect(() => {
    if (hasMore && !isRowsLoading) void loadMore();
  }, [hasMore, isRowsLoading, loadMore]);

  // Load select options for all select columns
  useEffect(() => {
    columns
      .filter((c) => c.type === 'select' || c.type === 'multi_select')
      .forEach((c) => loadSelectOptions(c.id));
  }, [columns, loadSelectOptions]);

  if (!table) return <div className="p-8 text-center text-gray-500">Loading table...</div>;

  // Re-resolved from the live rows: the panel closes by itself when its group is gone.
  const groupPanelRow = groupPanelId ? rows.find((r) => r.id === groupPanelId) : undefined;
  const groupPanel = groupPanelRow && isGroupRow(groupPanelRow, columns) ? groupPanelRow : null;

  const statusColumn = columns.find((c) => c.name === 'Status');
  const dateColumn = columns.find((c) => c.name === 'Date');

  const renderView = () => {
    switch (currentView?.type) {
      case 'board':
        return (
          <BoardView
            columns={tableColumns}
            rows={displayReceiptRows}
            selectOptions={selectOptions}
            config={{
              groupByColumnId: statusColumn?.id ?? '',
              showEmptyGroups: true,
            }}
            onCellChange={saveCell}
            onAddRow={(cells) => addRow({ cells })}
            onDeleteRow={deleteOne}
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
            columns={tableColumns}
            rows={displayReceiptRows}
            config={{ dateColumnId: dateColumn?.id ?? '' }}
          />
        );
      default:
        return (
          <TableView
            columns={tableColumns}
            rows={displayRows}
            selectOptions={selectOptions}
            onCellChange={saveCell}
            subItemsConfig={subItemsConfig}
            onCollapseRow={(rowId) => setGroupFolded(rowId, true)}
            onExpandRow={(rowId) => setGroupFolded(rowId, false)}
            getSubItemSummary={groupSummary}
            isCountedRow={isCountedRow}
            onAddRow={() => addRow()}
            onDeleteRow={deleteOne}
            onColumnResize={(columnId, width) => updateColumn(columnId, { width })}
            onColumnAlignmentChange={(columnId, alignment: TextAlignment) => updateColumn(columnId, { alignment })}
            enableKeyboardNav
            onRowOpen={(row) => (isGroupRow(row, columns) ? setGroupPanelId(row.id) : setDetailRow(row))}
            onAddProperty={(name, type: ColumnType) => addColumn({ name, type })}
            onCreateSelectOption={createSelectOption}
            onUpdateSelectOption={updateSelectOption}
            onDeleteSelectOption={deleteSelectOption}
            onUploadFile={uploadFile}
            onDeleteFile={deleteFile}
            selectedRows={selectedRows}
            onSelectionChange={setSelectedRows}
            onActiveRowChange={setActiveRowId}
            sorts={sorts}
            onSortChange={setSorts}
            isLoading={isRowsLoading}
            groupConfig={currentView?.config?.groupConfig as GroupConfig | undefined}
            onGroupConfigChange={(config) => {
              if (currentView) {
                updateView(currentView.id, {
                  config: { ...currentView.config, groupConfig: config },
                });
              }
            }}
            showFooter
            footerConfig={(currentView?.config?.footerConfig as FooterConfig | undefined) ?? { calculations: {} }}
            onFooterConfigChange={(config) => {
              if (currentView) {
                updateView(currentView.id, {
                  config: { ...currentView.config, footerConfig: config },
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
            <Link
              href="/app/overview"
              className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium rounded-lg transition-all duration-200"
              style={{ background: 'var(--surface)', color: 'var(--foreground)', border: '1px solid var(--border)' }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 3v18h18" />
                <rect x="7" y="10" width="3" height="8" />
                <rect x="12" y="6" width="3" height="12" />
                <rect x="17" y="13" width="3" height="5" />
              </svg>
              Overview
            </Link>
            <Link
              href="/app/finance"
              className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium rounded-lg transition-all duration-200"
              style={{ background: 'var(--surface)', color: 'var(--foreground)', border: '1px solid var(--border)' }}
              title="Einnahmenüberschussrechnung und offene Prüfungen"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M4 4h16v16H4z" />
                <path d="M8 9h8M8 13h8M8 17h5" />
              </svg>
              Finanzen
            </Link>
            <Link
              href="/app/meals"
              className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium rounded-lg transition-all duration-200"
              style={{ background: 'var(--surface)', color: 'var(--foreground)', border: '1px solid var(--border)' }}
              title={
                openMealCount > 0
                  ? `${openMealCount} Bewirtungen ohne Teilnehmer oder Anlass`
                  : 'Bewirtungsverzeichnis'
              }
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M7 3v8a2 2 0 0 0 2 2v8M5 3v5M9 3v5" />
                <path d="M17 3c-1.7 1.5-2.5 3.5-2.5 6s.8 4 2.5 4v8" />
              </svg>
              Bewirtung
              {openMealCount > 0 && (
                <span
                  className="rounded-full px-1.5 py-0.5 text-xs font-semibold tabular-nums"
                  style={{ background: 'var(--accent-muted)', color: 'var(--accent)' }}
                  aria-label={`${openMealCount} offen`}
                >
                  {openMealCount}
                </span>
              )}
            </Link>
            <Link
              href="/app/contacts"
              className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium rounded-lg transition-all duration-200"
              style={{ background: 'var(--surface)', color: 'var(--foreground)', border: '1px solid var(--border)' }}
              title="Personen und Organisationen mit Kundennummern"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <circle cx="9" cy="8" r="3.5" />
                <path d="M2.5 20c.6-3.4 3.2-5.5 6.5-5.5s5.9 2.1 6.5 5.5" />
                <path d="M16 4.8a3.5 3.5 0 0 1 0 6.4M18.5 14.9c1.6.9 2.7 2.6 3 5.1" />
              </svg>
              Kontakte
            </Link>
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
            <FxRecomputePanel />
            <Link
              href="/app/import"
              className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium rounded-lg transition-all duration-200"
              style={{ background: 'var(--surface)', color: 'var(--foreground)', border: '1px solid var(--border)' }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M14 3v4a1 1 0 0 0 1 1h4" />
                <path d="M17 21H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2z" />
                <path d="M9 13h6M9 17h6" />
              </svg>
              Import from Sheets
            </Link>
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
            {receiptRows.length} items · {tableColumns.length} properties
          </p>
          {/* Bulk edits set fields of receipts; a group in the selection is left alone. */}
          <BulkEditBar
            columns={tableColumns}
            selectOptions={selectOptions}
            loadSelectOptions={loadSelectOptions}
            selectedRows={
              selectedRows.size > 0
                ? new Set(selection.receiptIds)
                : activeRowId && receiptRows.some((r) => r.id === activeRowId)
                  ? new Set([activeRowId])
                  : selectedRows
            }
            updateCell={updateCell}
          />
          <GroupBar
            groups={groups}
            receiptCount={selection.receiptIds.length}
            inGroupCount={selection.inGroupIds.length}
            busy={working}
            onCreate={createGroup}
            onMoveInto={(groupId) => void moveIntoGroup(groupId, selection.receiptIds)}
            onTakeOut={() => void takeOutOfGroup(selection.inGroupIds)}
          />
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

      {notice && (
        <p role={notice.tone === 'ok' ? 'status' : 'alert'} className={`ui-note ui-note-${notice.tone} mx-4 mt-3 flex items-start justify-between gap-3`}>
          <span>{notice.text}</span>
          <button type="button" className="ui-btn ui-btn-sm ui-btn-ghost shrink-0" onClick={() => setNotice(null)}>
            Schließen
          </button>
        </p>
      )}

      <ReviewPanel
        entries={review}
        busy={working}
        error={reviewError}
        onOpen={(rowId) => {
          const row = rows.find((r) => r.id === rowId);
          if (row) setDetailRow(row);
          else setReviewError('Der Beleg ist in dieser Ansicht nicht geladen. Bitte Filter und Suche leeren.');
        }}
        onConfirm={(rowId) => void runReviewAction(() => confirmReceiptChecked(rowId))}
        onKeepBoth={(rowId, otherRowId) => void runReviewAction(() => keepBothLookAlikes(rowId, otherRowId))}
        onDelete={deleteOne}
        onTakeReading={(rowId, fields) =>
          void runReviewAction(async () => {
            const result = await takeNewReading(rowId, fields);
            // The table shows the receipt with its new values.
            if (result.ok) await refresh();
            return result;
          })
        }
      />

      <ConfirmDialog
        open={pendingDelete !== null}
        title={pendingDelete ? pendingWording.title : ''}
        confirmLabel={pendingWording.confirmLabel}
        danger
        busy={working}
        onConfirm={() => void confirmDelete()}
        onCancel={() => setPendingDelete(null)}
      >
        {pendingWording.body}
      </ConfirmDialog>

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
          columns={tableColumns}
          onSearchResults={(results, term) => setSearchResults(term ? results : null)}
        />
        <FilterBar
          columns={tableColumns}
          filters={filters}
          selectOptions={selectOptions}
          onFiltersChange={setFilters}
        />
      </div>

      {/* Table/Board/Calendar */}
      <div className="flex-1 overflow-auto p-4">
        {renderView()}
      </div>

      {/* Receipt Detail Panel — row is re-resolved from live rows so an
          upload/replace inside the panel shows up without reopening it */}
      {detailRow && (
        <ReceiptDetailPanel
          row={rows.find((r) => r.id === detailRow.id) ?? detailRow}
          columns={columns}
          selectOptions={selectOptions}
          onClose={() => setDetailRow(null)}
          onUploadFile={uploadFile}
          onDeleteFile={deleteFile}
          onMealSaved={() => {
            void refresh();
            void reloadReview();
          }}
        />
      )}

      {/* A group opens its own small panel: its receipts, their sum, take one out, dissolve it. */}
      {groupPanel && (
        <GroupPanel
          group={groupPanel}
          receipts={receiptsInGroup(groupPanel.id, rows, columns)}
          columns={columns}
          busy={working}
          onClose={() => setGroupPanelId(null)}
          onOpenReceipt={(row) => {
            setGroupPanelId(null);
            setDetailRow(row);
          }}
          onTakeOut={(rowId) => void takeOutOfGroup([rowId])}
          onDissolve={() => requestDelete([groupPanel.id])}
        />
      )}

      {/* AI Chat Sidebar. It works on receipts: a group is not handed to it. */}
      <AiChatSidebar
        isOpen={aiSidebarOpen}
        onClose={() => setAiSidebarOpen(false)}
        rows={receiptRows}
        columns={tableColumns}
        selectOptions={selectOptions}
        onCellChange={(rowId, columnId, value) => updateCell(rowId, columnId, value)}
        onAddRow={async (cells?: Record<string, CellValue>) => { await addRow({ cells }); }}
        onDeleteRow={deleteOne}
        onCreateSelectOption={(params) => createSelectOption(params.columnId, params.name, params.color)}
        tableId={tableId}
      />
    </div>
  );
}

export default function DashboardClient({ tableId, workspaceId, openMealCount, initialReview }: DashboardClientProps) {
  return (
    <DataTableProvider dbAdapter={dbAdapter} fileAdapter={fileAdapter} workspaceId={workspaceId}>
      <DashboardContent tableId={tableId} openMealCount={openMealCount} initialReview={initialReview} />
    </DataTableProvider>
  );
}
