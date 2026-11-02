import { computed, makeAutoObservable, observable, reaction } from 'mobx';
import type { CellValue, Column, CreateFileRefInput, CreateRowInput, FileReference, QueryFilter, QueryOptions, QueryResult, QuerySort, Row, UploadedFile } from '@marlinjai/data-table-core';
import type { UpdatedRow } from '@/app/app/dashboard/actions';
import type { NavCounts } from '@/app/app/nav-actions';
import type { PlacedOrder } from '@/lib/groups/order';
import { groupsOf, receiptsInGroup, type GroupOption } from '@/lib/groups/view';
import type { YearCounts } from '@/lib/receipt-year-counts';
import { scopeOf, type YearScope, type YearSelection } from '@/lib/receipt-years';
import { receiptsOnly } from '@/lib/receipts-kind';
import type { ReviewEntry } from '@/lib/review/service';

/** How many rows one request asks for. */
export const PAGE_SIZE = 200;
/** The most times a list that does not add up is read again. */
export const MAX_REPAIRS = 2;
/** The year chips and the meal count are asked again this long after a row changed, so a run of edits asks once. */
export const COUNTS_DELAY_MS = 600;

/** What the store needs from outside: the server actions, and the file storage. */
export interface ReceiptsApi {
  getRows(tableId: string, query: QueryOptions & YearScope): Promise<QueryResult<Row>>;
  createRow(input: CreateRowInput): Promise<Row>;
  updateRow(rowId: string, cells: Record<string, CellValue>): Promise<UpdatedRow>;
  getYearCounts(tableId: string): Promise<YearCounts>;
  getNavCounts(): Promise<{ ok: true; value: NavCounts } | { ok: false }>;
  uploadFile(file: File): Promise<UploadedFile>;
  deleteStoredFile(fileId: string): Promise<void>;
  addFileReference(input: CreateFileRefInput): Promise<FileReference>;
  removeFileReference(fileRefId: string): Promise<void>;
}

export interface ReceiptsSeed {
  tableId: string;
  years: YearSelection;
  yearCounts: YearCounts;
  /** The review list as the page loaded it. Null when loading it failed. */
  review: ReviewEntry[] | null;
  openMeals: number;
}

/** The rows, each once, in the place it was first read. */
export function uniqueRows(rows: readonly Row[]): Row[] {
  const seen = new Set<string>();
  const out: Row[] = [];
  for (const row of rows) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    out.push(row);
  }
  return out;
}

function sameRow(a: Row, b: Row): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * The receipts table on the client: the one copy of the rows, what is asked of
 * the server, and everything worked out from them. A row is replaced whole and
 * only when it changed, also by a reload, so a view can tell by its object
 * whether it has to redraw. The columns stay the table package's; the store is
 * told them, because a row is only a receipt or a group by its columns.
 *
 * One load runs at a time: a newer one takes over and the older one's late
 * answers are dropped. A reload swaps the list when all pages are in. A new
 * question (years, filters, sorts) fills it page by page, so the first receipts
 * show at once. A list with a row twice, or with another number of rows than the
 * server counted, is read again, at most `MAX_REPAIRS` times: a receipt added
 * while the pages arrive moves the rest by one. A row added or saved during a
 * load stays over what that load read, which may be older.
 *
 * Plan: docs/plans/2026-11-01-client-state.md, slice 3.
 */
export class ReceiptsStore {
  private byId = observable.map<string, Row>([], { deep: false });
  /** Rows added or saved since the running load started: what it read of them may be older, or nothing. */
  private savedDuringLoad = new Map<string, Row>();
  private run = 0;
  private running: Promise<void> = Promise.resolve();
  private yearsAsked = 0;
  private mealsAsked = 0;
  /** Goes up with every change to a row: the year chips and the meal count follow it. */
  private changes = 0;
  private columns: Column[] = [];
  private readonly tableId: string;
  private readonly api: ReceiptsApi;
  /** False while the review list could not be loaded and nothing has replaced it. */
  private reviewKnown: boolean;
  /** False while the last list had another number of rows than the server counted. */
  private addedUp = false;

  /** True until the list is all there: only then may the page conclude that a receipt is not in it. */
  loading = true;
  loadFailed = false;
  years: YearSelection;
  filters: QueryFilter[] = [];
  sorts: QuerySort[] = [];
  /** A group's order as just placed, until the rows have been loaded again. */
  placedOrder: PlacedOrder | null = null;
  yearCounts: YearCounts;
  review: ReviewEntry[];
  /** Business meals that still lack guests or occasion: the server's number, since the page loads no meals. */
  openMeals: number;

  constructor(seed: ReceiptsSeed, api: ReceiptsApi) {
    this.tableId = seed.tableId;
    this.api = api;
    this.years = seed.years;
    this.yearCounts = seed.yearCounts;
    this.review = seed.review ?? [];
    this.reviewKnown = seed.review !== null;
    this.openMeals = seed.openMeals;
    makeAutoObservable<ReceiptsStore, 'byId' | 'savedDuringLoad' | 'run' | 'running' | 'yearsAsked' | 'mealsAsked' | 'columns' | 'tableId' | 'api'>(
      this,
      {
        byId: false,
        savedDuringLoad: false,
        run: false,
        running: false,
        yearsAsked: false,
        mealsAsked: false,
        tableId: false,
        api: false,
        columns: observable.ref,
        years: observable.ref,
        filters: observable.ref,
        sorts: observable.ref,
        placedOrder: observable.ref,
        yearCounts: observable.ref,
        review: observable.ref,
        rows: computed,
      },
      { autoBind: true },
    );
  }

  get rows(): Row[] {
    return [...this.byId.values()];
  }

  /** The rows that are receipts: everything that counts or sums works on these. */
  get receipts(): Row[] {
    return receiptsOnly(this.rows, this.columns);
  }

  get groups(): GroupOption[] {
    return groupsOf(this.rows, this.columns);
  }

  /** How many receipts there are in all, also in the years that are not loaded. */
  get totalReceipts(): number {
    return this.yearCounts.years.reduce((sum, y) => sum + y.count, 0) + this.yearCounts.undated;
  }

  /** Null while the list could not be loaded: the navigation then keeps what it knows, never a wrong zero. */
  get reviewCount(): number | null {
    return this.reviewKnown ? this.review.length : null;
  }

  /** Every row of the question is here: only then may anything be taken from the list as a whole, like an export. */
  get complete(): boolean {
    return !this.loading && !this.loadFailed && this.addedUp;
  }

  row(rowId: string): Row | undefined {
    return this.byId.get(rowId);
  }

  receiptsInGroup(groupId: string): Row[] {
    return receiptsInGroup(groupId, this.rows, this.columns);
  }

  /** The page opened: load the list and follow it. The return is for when it closes, and drops every answer on its way. */
  open(): () => void {
    const stop = reaction(
      () => this.changes,
      () => {
        void this.askYearCounts();
        void this.askOpenMeals();
      },
      { delay: COUNTS_DELAY_MS },
    );
    // The chips were counted before the list came, and the page may have failed to count them.
    void this.startLoad(true).then(() => this.askYearCounts());
    return () => {
      stop();
      this.run += 1;
      this.running = Promise.resolve();
      this.yearsAsked += 1;
      this.mealsAsked += 1;
    };
  }

  /** Load the list again. Resolves when it is in (or failed, which `loadFailed` says) and never rejects. */
  load(): Promise<void> {
    return this.startLoad(false);
  }

  yearsChanged(years: YearSelection): void {
    this.years = years;
    void this.startLoad(true);
  }

  filtersChanged(filters: QueryFilter[]): void {
    this.filters = filters;
    void this.startLoad(true);
  }

  sortsChanged(sorts: QuerySort[]): void {
    this.sorts = sorts;
    void this.startLoad(true);
  }

  orderPlaced(placed: PlacedOrder | null): void {
    this.placedOrder = placed;
  }

  columnsChanged(columns: Column[]): void {
    this.columns = columns;
  }

  reviewReplaced(entries: ReviewEntry[]): void {
    this.review = entries;
    this.reviewKnown = true;
  }

  /** Rows that were deleted: they leave the list at once, and the review list with them. */
  rowsRemoved(rowIds: Iterable<string>): void {
    const gone = new Set(rowIds);
    for (const id of gone) {
      this.byId.delete(id);
      this.savedDuringLoad.delete(id);
    }
    this.review = this.review.filter((entry) => !gone.has(entry.rowId)).map((entry) => ({ ...entry, duplicates: entry.duplicates.filter((d) => !gone.has(d.rowId)) }));
    this.changes += 1;
  }

  /** A row the server answered with. One the list no longer has stays out: a save can arrive after its delete. */
  private rowSaved(row: Row): void {
    if (!this.byId.has(row.id)) return;
    this.byId.set(row.id, row);
    this.savedDuringLoad.set(row.id, row);
    this.changes += 1;
  }

  private rowAdded(row: Row): void {
    this.byId.replace([[row.id, row], ...this.byId.entries()]);
    this.savedDuringLoad.set(row.id, row);
    this.changes += 1;
  }

  async addRow(cells?: Record<string, CellValue>): Promise<Row> {
    const row = await this.api.createRow({ tableId: this.tableId, cells });
    this.rowAdded(row);
    return row;
  }

  async updateCell(rowId: string, columnId: string, value: CellValue): Promise<UpdatedRow> {
    const row = await this.api.updateRow(rowId, { [columnId]: value });
    this.rowSaved(row);
    return row;
  }

  /**
   * The stored file, then its reference, then a write of the cell. Files live in a
   * table of their own and a row is answered with them, so the reference comes first:
   * the answer then shows the upload, with the id the server gave it for deleting it.
   */
  async uploadFile(rowId: string, columnId: string, file: File): Promise<FileReference> {
    const uploaded = await this.api.uploadFile(file);
    const files = (this.byId.get(rowId)?.cells[columnId] as FileReference[] | null) ?? [];
    const fileRef = await this.api.addFileReference({
      rowId,
      columnId,
      fileId: uploaded.id,
      fileUrl: uploaded.url,
      originalName: uploaded.originalName,
      mimeType: uploaded.mimeType,
      sizeBytes: uploaded.sizeBytes,
      position: files.length,
      metadata: uploaded.metadata,
    });
    await this.updateCell(rowId, columnId, [...files, fileRef]);
    return fileRef;
  }

  async deleteFile(rowId: string, columnId: string, fileId: string): Promise<void> {
    const files = (this.byId.get(rowId)?.cells[columnId] as FileReference[] | null) ?? [];
    const fileRef = files.find((f) => f.fileId === fileId);
    if (!fileRef) return;
    await this.api.deleteStoredFile(fileId);
    await this.api.removeFileReference(fileRef.id);
    await this.updateCell(rowId, columnId, files.filter((f) => f.fileId !== fileId));
  }

  private startLoad(pageByPage: boolean): Promise<void> {
    this.run += 1;
    this.loading = true;
    this.loadFailed = false;
    this.savedDuringLoad.clear();
    this.running = this.read(this.run, pageByPage);
    return this.running;
  }

  private async read(run: number, pageByPage: boolean): Promise<void> {
    try {
      for (let repairs = 0; ; repairs += 1) {
        const read = await this.readPages(run, pageByPage && repairs === 0);
        // A newer load took over: whoever waits for this one waits for that one.
        if (run !== this.run) return this.running;
        const rows = uniqueRows(read.rows);
        const addsUp = rows.length === read.rows.length && rows.length === read.total;
        if (addsUp || repairs >= MAX_REPAIRS) return this.finish(rows, pageByPage, addsUp);
      }
    } catch {
      // Not asked again by itself, that would ask a server that is down without end. The next load starts over.
      if (run === this.run) this.failed();
    }
  }

  private finish(rows: Row[], pageByPage: boolean, addsUp: boolean): void {
    // A list read for a new question answers that question; only a reload can say that a row changed.
    if (this.commit(rows) && !pageByPage) this.changes += 1;
    this.addedUp = addsUp;
    this.loading = false;
  }

  private failed(): void {
    this.loadFailed = true;
    this.loading = false;
  }

  private async readPages(run: number, pageByPage: boolean): Promise<{ rows: Row[]; total: number }> {
    const rows: Row[] = [];
    const { filters, sorts } = this;
    const years = scopeOf(this.years);
    for (;;) {
      const page = await this.api.getRows(this.tableId, { filters, sorts, limit: PAGE_SIZE, offset: rows.length, includeArchived: false, include: ['files'], years });
      if (run !== this.run) return { rows, total: rows.length };
      rows.push(...page.items);
      if (!page.hasMore || page.items.length === 0) return { rows, total: page.total };
      if (pageByPage) this.commit(uniqueRows(rows));
    }
  }

  /** The list as read, keeping the object of every row that did not change. Says whether anything did. */
  private commit(rows: Row[]): boolean {
    const before = [...this.byId.values()];
    const read = new Set(rows.map((row) => row.id));
    const unread = [...this.savedDuringLoad.values()].filter((row) => !read.has(row.id));
    const next = rows.map((row) => {
      const known = this.byId.get(row.id);
      return this.savedDuringLoad.get(row.id) ?? (known && sameRow(known, row) ? known : row);
    });
    next.unshift(...unread);
    this.byId.replace(next.map((row) => [row.id, row]));
    return next.length !== before.length || next.some((row, i) => row !== before[i]);
  }

  private async askYearCounts(): Promise<void> {
    this.yearsAsked += 1;
    const asked = this.yearsAsked;
    const yearCounts = await this.api.getYearCounts(this.tableId).catch(() => null);
    if (asked === this.yearsAsked && yearCounts) this.yearCountsAnswered(yearCounts);
  }

  /** Apart from the year chips: a new question for those must not drop an answer on its way for this. */
  private async askOpenMeals(): Promise<void> {
    this.mealsAsked += 1;
    const asked = this.mealsAsked;
    const nav = await this.api.getNavCounts().catch(() => null);
    if (asked === this.mealsAsked && nav?.ok) this.openMealsAnswered(nav.value.meals);
  }

  /** Each is help, not a condition: without an answer the last stands. */
  private yearCountsAnswered(yearCounts: YearCounts): void {
    this.yearCounts = yearCounts;
  }

  private openMealsAnswered(openMeals: number): void {
    this.openMeals = openMeals;
  }
}
