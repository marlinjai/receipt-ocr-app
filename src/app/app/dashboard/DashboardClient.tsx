'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import Link from 'next/link';
import {
  DataTableProvider,
  useTable,
  useViews,
  TableView,
  BoardView,
  CalendarView,
  ViewSwitcher,
  useTableSearch,
  FilterBar,
} from '@marlinjai/data-table-react';
import type { Column, ColumnType, Row, GroupConfig, FooterConfig, SubItemsConfig, TextAlignment, CellValue } from '@marlinjai/data-table-core';
import { createServerActionsAdapter } from './server-actions-adapter';
import { deleteReceiptsForGood, getReceiptText, getReceiptYear, getYearCounts, searchReceiptText, setFieldOnRows } from './actions';
import { scopeOf, setYearScope } from './year-scope';
import { useCompleteRows } from './use-complete-rows';
import type { YearCounts } from '@/lib/receipt-year-counts';
import { MIN_TEXT_SEARCH_LENGTH, listColumns } from '@/lib/receipt-text';
import { confirmReceiptChecked, getReviewQueue, keepBothLookAlikes, takeNewReading, type ReviewActionError, type ReviewResult } from './review-actions';
import FxRecomputePanel from './FxRecomputePanel';
import DashboardPhoneActions from './DashboardPhoneActions';
import ReceiptPhoneList from './ReceiptPhoneList';
import { AiIcon, ContactsIcon, ExportIcon, FinanceIcon, ImportIcon, MealsIcon, OverviewIcon } from './dashboard-icons';
import { usePhone } from '@/lib/use-phone';
import BulkEditBar from './BulkEditBar';
import GroupBar from './GroupBar';
import GroupPanel from './GroupPanel';
import { createReceiptGroup, moveReceiptsIntoGroup, removeReceiptsFromGroup, type GroupActionError, type GroupResult } from './group-actions';
import AiChatSidebar from '@/components/AiChatSidebar';
import ReceiptDetailPanel from '@/components/ReceiptDetailPanel';
import { rereadReceipt } from '../actions';
import { rereadNote } from '@/lib/review/reread';
import ReviewPanel from '@/components/review/ReviewPanel';
import ConfirmDialog from '@/components/ui/ConfirmDialog';
import type { ReviewEntry } from '@/lib/review/service';
import { PresignedStorageBrainAdapter } from '@/lib/presigned-file-adapter';
import { exportCSV } from '@/lib/export-csv';
import { isGroupRow, receiptsOnly, visibleColumns } from '@/lib/receipts-kind';
import { deleteWording, deletedWording, groupCellNote, groupCellValue, groupsOf, receiptsInGroup, searchWithGroupReceipts, selectionKinds } from '@/lib/groups/view';
import YearFilter from './YearFilter';
import ReceiptSearch from './ReceiptSearch';
import { ALL_YEARS, YEAR_PARAM, filterByYears, formatYearParam, hasYearFilter, newestYear, parseYearParam, type YearSelection } from '@/lib/receipt-years';

const dbAdapter = createServerActionsAdapter();
const fileAdapter = new PresignedStorageBrainAdapter();

interface DashboardClientProps {
  tableId: string;
  workspaceId: string;
  /** Business meals that still lack guests or occasion (see /app/meals). */
  openMealCount: number;
  /** Receipts that need a look, as loaded with the page. Null when loading them failed. */
  initialReview: ReviewEntry[] | null;
  /** The receipt a link from another area asks to open (see `receiptHref`); null without one. */
  openRowId: string | null;
  initialYears: string | null;
  /** How many receipts each year has, counted on the server (no row is loaded for it). */
  yearCounts: YearCounts;
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

function DashboardContent({ tableId, openMealCount, initialReview, openRowId, initialSelection, initialCounts }: { tableId: string; openMealCount: number; initialReview: ReviewEntry[] | null; openRowId: string | null; initialSelection: YearSelection; initialCounts: YearCounts }) {
  const {
    table,
    columns,
    rows: loadedRows,
    total,
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
    rowsError,
    loadSelectOptions,
    refresh,
  } = useTable({ tableId, pageSize: 200 });
  // The rows complete and each once, every load one after another (see `use-complete-rows.ts`). Every reload
  // the dashboard asks for goes through `reload`, never the package's own refresh, so it cannot cross a page on
  // its way. (A filter or sort change loads beside it, inside the package; a list that then does not add up is
  // loaded again, at most twice per reload the dashboard asks for.)
  const { rows, reload, settled } = useCompleteRows({ rows: loadedRows, total, hasMore, isLoading: isRowsLoading, error: rowsError, loadMore, refresh });

  const {
    views,
    currentView,
    createView,
    updateView,
    deleteView,
    setCurrentView,
  } = useViews({ tableId });

  const [selectedRows, setSelectedRows] = useState<Set<string>>(new Set());
  // The keyboard-focused row (Notion-style implicit selection): bulk edits
  // apply to it when nothing is checkbox-selected. Destructive actions
  // (delete) intentionally still require an explicit selection.
  const [activeRowId, setActiveRowId] = useState<string | null>(null);
  const [aiSidebarOpen, setAiSidebarOpen] = useState(false);
  // Below the `sm` width the receipts show as a card list instead of the wide table (plan 2026-10-24-phone-layout).
  const isPhone = usePhone();
  const [detailRow, setDetailRow] = useState<Row | null>(null);
  const [groupPanelId, setGroupPanelId] = useState<string | null>(null);
  // A group is a row that holds receipts and is never one itself (see
  // `lib/receipts-kind.ts`). The table draws groups; everything that counts,
  // edits in bulk, exports or hands rows to the assistant works on receipts.
  // The column that says which rows are groups is not shown or edited.
  const tableColumns = useMemo(() => listColumns(visibleColumns(columns)), [columns]);
  // The names, vendors and amounts are searched in the list, live as rows arrive; the recognized text is
  // not in the list and is searched on the server. A receipt is found when either finds it.
  const { searchTerm, setSearchTerm, filteredRows: listHits } = useTableSearch(rows, tableColumns);
  const [textHits, setTextHits] = useState<{ ids: Set<string>; truncated: boolean } | null>(null);
  const [textSearchFailed, setTextSearchFailed] = useState(false);
  const trimmedTerm = searchTerm.trim();
  const textSearched = trimmedTerm.length >= MIN_TEXT_SEARCH_LENGTH;
  useEffect(() => {
    if (!textSearched) return;
    let current = true;
    setTextSearchFailed(false);
    const timer = setTimeout(() => {
      searchReceiptText(tableId, trimmedTerm)
        .then((result) => current && setTextHits({ ids: new Set(result.ids), truncated: result.truncated }))
        // A failed text search leaves the list search as it is, and the field says so: the person still finds
        // names and vendors, but must not read the count as covering the recognized text.
        .catch(() => {
          if (!current) return;
          setTextHits(null);
          setTextSearchFailed(true);
        });
    }, 350);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [trimmedTerm, textSearched, tableId]);
  // The hits of the previous term stay until the new ones arrive: typing on must not make receipts blink out.
  const activeTextHits = textSearched ? textHits : null;
  // Receipts the text search found that lie in years that are not loaded: said next to the count, not shown.
  const elsewhere = useMemo(() => {
    if (!activeTextHits) return 0;
    const loaded = new Set(rows.map((r) => r.id));
    return [...activeTextHits.ids].filter((id) => !loaded.has(id)).length;
  }, [activeTextHits, rows]);
  const searchResults = useMemo(() => {
    if (!trimmedTerm) return null;
    if (!activeTextHits || activeTextHits.ids.size === 0) return listHits;
    const found = new Set(listHits.map((r) => r.id));
    return [...listHits, ...rows.filter((r) => activeTextHits.ids.has(r.id) && !found.has(r.id))];
  }, [trimmedTerm, listHits, activeTextHits, rows]);
  // A search that finds a group shows the group's receipts with it (see `searchWithGroupReceipts`).
  const searchedRows = useMemo(
    () => (searchResults ? searchWithGroupReceipts(searchResults, rows, columns) : rows),
    [searchResults, rows, columns],
  );
  // The years chosen above the table. They narrow what every view and the export show (see `lib/receipt-years.ts`).
  const [yearSelection, setYearSelection] = useState<YearSelection>(initialSelection);
  const [counts, setCounts] = useState<YearCounts>(initialCounts);
  const changeYears = useCallback(
    (next: YearSelection) => {
      setYearSelection(next);
      // The server loads only these years; the list is fetched again for the new choice.
      setYearScope(scopeOf(next));
      void reload();
      // Kept in the address, so a reload or a copied link shows the same years; "alle" is a choice, not a default.
      const url = new URL(window.location.href);
      url.searchParams.set(YEAR_PARAM, formatYearParam(next) || ALL_YEARS);
      window.history.replaceState(null, '', url);
    },
    [reload],
  );
  const displayRows = useMemo(() => filterByYears(searchedRows, columns, yearSelection), [searchedRows, columns, yearSelection]);
  // The chips follow the table: a receipt deleted, added or re-dated changes the rows, and the counts are asked
  // again a moment after the rows settle (one cheap query, no row is loaded).
  useEffect(() => {
    let current = true;
    const timer = setTimeout(() => {
      getYearCounts(tableId)
        .then((next) => current && setCounts(next))
        .catch(() => undefined);
    }, 600);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [rows.length, tableId]);
  const totalReceipts = useMemo(() => counts.years.reduce((sum, y) => sum + y.count, 0) + counts.undated, [counts]);

  const receiptRows = useMemo(() => receiptsOnly(rows, columns), [rows, columns]);
  const displayReceiptRows = useMemo(() => receiptsOnly(displayRows, columns), [displayRows, columns]);
  const groups = useMemo(() => groupsOf(rows, columns), [rows, columns]);
  const selection = useMemo(() => selectionKinds(selectedRows, rows, columns), [selectedRows, rows, columns]);
  const isCountedRow = useCallback((row: Row) => !isGroupRow(row, columns), [columns]);
  // A row the years hide is no longer selected: a bulk edit or a delete must only reach what the page shows.
  useEffect(() => {
    if (!hasYearFilter(yearSelection)) return;
    const shown = new Set(displayRows.map((r) => r.id));
    setSelectedRows((current) => {
      const kept = [...current].filter((id) => shown.has(id));
      return kept.length === current.size ? current : new Set(kept);
    });
  }, [displayRows, yearSelection]);
  const groupSummary = useCallback(
    (row: Row, children: Row[], column: Column) => groupCellValue(row, children, column, columns),
    [columns],
  );
  const groupSummaryNote = useCallback(
    (row: Row, children: Row[], column: Column) => groupCellNote(row, children, column, columns),
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
      // The delete is done and said above. If the review list cannot be reloaded now, say that
      // too; a table that cannot be reloaded says so in its own banner (`rowsError`).
      try {
        await Promise.all([reload(), reloadReview()]);
      } catch {
        setReviewError('Die Ansicht konnte nicht neu geladen werden. Bitte die Seite neu laden.');
      }
    }
  }, [pendingDelete, pendingGroupIds, working, reload, reloadReview]);

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
        // A table that cannot be reloaded says so in its own banner (`rowsError`).
        await reload();
      }
      return ok;
    },
    [working, reload],
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
        void reload();
      });
    },
    [updateCell, reload],
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

  // A link from another area (a finance line, a payment) opens its receipt:
  // once, as soon as the row has arrived. The table loads in pages, so the row
  // may come with a later one; only when every page is in and it is still
  // missing is the receipt said to be gone (deleted, or of another company).
  // The receipt to open: the one a link names, and later one the review list or a check asks for. When it is
  // not among the loaded rows it may lie in a year that is not loaded: its year is looked up and added to
  // the choice, and only when it is still missing after that is it said to be gone.
  const [pendingOpenId, setPendingOpenId] = useState<string | null>(openRowId);
  const widenedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!pendingOpenId) return;
    const row = rows.find((r) => r.id === pendingOpenId);
    if (row) {
      setPendingOpenId(null);
      if (isGroupRow(row, columns)) setGroupPanelId(row.id);
      else setDetailRow(row);
      return;
    }
    // Only a list that is all there can say that a receipt is not in it. A list that failed to load says so in
    // its banner, and the link waits for the next reload instead of calling the receipt deleted.
    if (!settled || rowsError || columns.length === 0) return;
    const gone = () => {
      setPendingOpenId(null);
      setNotice({ tone: 'warn', text: 'Der verlinkte Beleg ist in dieser Tabelle nicht vorhanden. Er wurde gelöscht oder gehört zu einem anderen Unternehmen.' });
    };
    if (widenedFor.current === pendingOpenId) {
      gone();
      return;
    }
    widenedFor.current = pendingOpenId;
    const wanted = pendingOpenId;
    void getReceiptYear(wanted)
      .then((year) => {
        const shown = yearSelection.years.size === 0 && !yearSelection.undated;
        if (year === null || shown || yearSelection.years.has(year)) {
          // Already in the years shown, or without a date: undated receipts come with "ohne Datum".
          if (year === null && !yearSelection.undated && !shown) changeYears({ years: yearSelection.years, undated: true });
          else gone();
          return;
        }
        changeYears({ years: new Set([...yearSelection.years, year]), undated: yearSelection.undated });
      })
      .catch(() => gone());
  }, [pendingOpenId, rows, columns, settled, rowsError, yearSelection, changeYears]);

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
        // The width is not known until the page runs in the browser: neither the list nor the table until then.
        if (isPhone === null) return null;
        if (isPhone) {
          return (
            <ReceiptPhoneList
              rows={displayRows}
              loadedRows={rows}
              columns={columns}
              selectOptions={selectOptions}
              loading={!settled}
              failed={Boolean(rowsError)}
              narrowed={Boolean(trimmedTerm) || filters.length > 0 || hasYearFilter(yearSelection)}
              onOpenReceipt={setDetailRow}
              onOpenGroup={(row) => setGroupPanelId(row.id)}
            />
          );
        }
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
            getSubItemSummaryNote={groupSummaryNote}
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
      className="flex min-h-screen flex-col sm:h-screen"
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
      <div className="px-4 pt-4 pb-2 sm:px-6 sm:pt-6" style={{ background: 'rgba(10, 10, 15, 0.4)' }}>
        {/* On a phone the nine actions below would push the page sideways: the phone row takes this row's place. */}
        <DashboardPhoneActions
          title={table.name}
          openMealCount={openMealCount}
          onExport={() => exportCSV({ columns, rows: displayRows })}
          onToggleAi={() => setAiSidebarOpen((v) => !v)}
        />
        <div className="mb-1 hidden items-center justify-between sm:flex">
          <h1 className="text-2xl font-bold" style={{ color: 'var(--dt-text-primary)' }}>
            {table.name}
          </h1>
          <div className="flex items-center gap-2">
            <Link
              href="/app/overview"
              className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium rounded-lg transition-all duration-200"
              style={{ background: 'var(--surface)', color: 'var(--foreground)', border: '1px solid var(--border)' }}
            >
              <OverviewIcon />
              Overview
            </Link>
            <Link
              href="/app/finance"
              className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium rounded-lg transition-all duration-200"
              style={{ background: 'var(--surface)', color: 'var(--foreground)', border: '1px solid var(--border)' }}
              title="Einnahmenüberschussrechnung und offene Prüfungen"
            >
              <FinanceIcon />
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
              <MealsIcon />
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
              <ContactsIcon />
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
              <ExportIcon />
              Export CSV
            </button>
            <FxRecomputePanel />
            <Link
              href="/app/import"
              className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium rounded-lg transition-all duration-200"
              style={{ background: 'var(--surface)', color: 'var(--foreground)', border: '1px solid var(--border)' }}
            >
              <ImportIcon />
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
              <AiIcon />
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
            {receiptRows.length < totalReceipts ? `${receiptRows.length} von ${totalReceipts}` : receiptRows.length} items<span className="max-sm:hidden"> · {tableColumns.length} properties</span>
          </p>
          {/* Selecting, bulk edits and groups work on the wide table; the phone list has no selection, so they stay off there. */}
          <div className="hidden items-center gap-3 sm:flex">
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
              setField={setFieldOnRows}
              onDone={reload}
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
      </div>

      {/* A list that failed to load is said for as long as it is so: its counts and sums are of the rows shown,
          and nothing is asked again by itself. The next reload (a year chip, an action, the page) starts over. */}
      {rowsError && (
        <p role="alert" className="ui-note ui-note-danger mx-4 mt-3">
          Die Belege konnten nicht vollständig geladen werden. Anzahl und Summen gelten nur für die gezeigten Zeilen. Bitte die Seite neu laden.
        </p>
      )}

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
          // Not among the loaded rows: its year is added to the years shown and it opens when it arrives.
          if (row) setDetailRow(row);
          else setPendingOpenId(rowId);
        }}
        onConfirm={(rowId) => void runReviewAction(() => confirmReceiptChecked(rowId))}
        onKeepBoth={(rowId, otherRowId) => void runReviewAction(() => keepBothLookAlikes(rowId, otherRowId))}
        onDelete={deleteOne}
        onTakeReading={(rowId, fields) =>
          void runReviewAction(async () => {
            const result = await takeNewReading(rowId, fields);
            // The table shows the receipt with its new values.
            if (result.ok) await reload();
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

      {/* View Switcher. On a phone the package's tab row (with its rename and add menus) is wider than the screen,
          so a plain picker switches the views there; creating and renaming views stays on the wide layout. */}
      {isPhone === null ? null : isPhone ? (
        <div className="flex items-center gap-2 px-4 py-2" style={{ borderBottom: '1px solid var(--dt-border-color)', background: 'var(--dt-bg-secondary)' }}>
          <label htmlFor="phone-view-picker" className="text-sm" style={{ color: 'var(--dt-text-secondary)' }}>
            Ansicht
          </label>
          <select
            id="phone-view-picker"
            className="ui-input min-h-11 min-w-0 flex-1"
            value={currentView?.id ?? ''}
            onChange={(e) => setCurrentView(e.target.value)}
          >
            {views.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </select>
        </div>
      ) : (
        <ViewSwitcher
          views={views}
          currentViewId={currentView?.id ?? null}
          onViewChange={(viewId) => setCurrentView(viewId)}
          onCreateView={(type) => createView({ name: type, type })}
          onDeleteView={deleteView}
          onRenameView={(viewId, name) => updateView(viewId, { name })}
        />
      )}

      {/* Search & Filter */}
      <div className="dashboard-filter-row px-4 py-2 flex flex-wrap gap-2 items-center" style={{ borderBottom: '1px solid var(--dt-border-color)', background: 'rgba(10, 10, 15, 0.3)' }}>
        <ReceiptSearch
          term={searchTerm}
          onTermChange={setSearchTerm}
          count={searchResults ? receiptsOnly(searchResults, columns).length : null}
          truncated={Boolean(activeTextHits?.truncated)}
          textFailed={textSearched && textSearchFailed}
          elsewhere={elsewhere}
        />
        <FilterBar
          columns={tableColumns}
          filters={filters}
          selectOptions={selectOptions}
          onFiltersChange={setFilters}
          bare
        />
        <YearFilter
          years={counts.years}
          undated={counts.undated}
          selection={yearSelection}
          shown={displayReceiptRows.length}
          total={totalReceipts}
          onChange={changeYears}
        />
      </div>

      {/* Table/Board/Calendar */}
      {/* On a phone the page itself scrolls down the list; the board and the calendar scroll sideways in here, never the page. */}
      <div className="p-4 max-sm:overflow-x-auto sm:flex-1 sm:overflow-auto">
        {renderView()}
      </div>

      {/* Receipt Detail Panel — row is re-resolved from live rows so an
          upload/replace inside the panel shows up without reopening it */}
      {detailRow && (
        <ReceiptDetailPanel
          // One panel per receipt: the text of the previous receipt must never show while the next one loads.
          key={detailRow.id}
          row={rows.find((r) => r.id === detailRow.id) ?? detailRow}
          columns={columns}
          selectOptions={selectOptions}
          onClose={() => setDetailRow(null)}
          loadText={getReceiptText}
          onUploadFile={uploadFile}
          onDeleteFile={deleteFile}
          onMealSaved={() => {
            void reload();
            void reloadReview();
          }}
          onReread={async (rowId) => {
            const result = await rereadReceipt(rowId);
            // The table and the review list show the receipt as it is read now.
            const note = rereadNote(result);
            if (result.ok) {
              // The table's own failure shows in its banner; only the review list's is caught here.
              try {
                await Promise.all([reload(), reloadReview()]);
              } catch {
                return { ...note, text: `${note.text} Die Ansicht konnte nicht neu geladen werden. Bitte die Seite neu laden.` };
              }
            }
            return note;
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
        loadText={getReceiptText}
        selectOptions={selectOptions}
        onCellChange={saveCell}
        onAddRow={async (cells?: Record<string, CellValue>) => { await addRow({ cells }); }}
        onDeleteRow={deleteOne}
        onCreateSelectOption={(params) => createSelectOption(params.columnId, params.name, params.color)}
        tableId={tableId}
      />
    </div>
  );
}

export default function DashboardClient({ tableId, workspaceId, openMealCount, initialReview, openRowId, initialYears, yearCounts }: DashboardClientProps) {
  // The table opens on the year the address names, "alle", or the newest year that has receipts. The scope is
  // set before the table first asks for rows, so the first request is already narrowed.
  const [initialSelection] = useState<YearSelection>(() => {
    const named = parseYearParam(initialYears);
    const all = initialYears?.trim().toLowerCase() === ALL_YEARS;
    const newest = newestYear(yearCounts.years);
    const selection: YearSelection = hasYearFilter(named) || all || newest === null ? named : { years: new Set([newest]), undated: false };
    setYearScope(scopeOf(selection));
    return selection;
  });
  return (
    <DataTableProvider dbAdapter={dbAdapter} fileAdapter={fileAdapter} workspaceId={workspaceId}>
      <DashboardContent tableId={tableId} openMealCount={openMealCount} initialReview={initialReview} openRowId={openRowId} initialSelection={initialSelection} initialCounts={yearCounts} />
    </DataTableProvider>
  );
}
