import type { Column, Row } from '@marlinjai/data-table-core';
import type { PrismaClient } from '@prisma/client';
import { firstColumnIdByName } from '@/lib/column-lookup';
import { allReceiptRows, tableContext } from '@/lib/meals/service';
import type { SelectOptionsByColumn } from '@/lib/meals/record';
import { timed } from '@/lib/timing';
import type { OfflineReceipt } from './receipts-db';

/** The status options as the offline page says them (the table stores them in English). */
const STATUS_LABELS: Record<string, string> = { Pending: 'Offen', Processed: 'Erledigt', Rejected: 'Abgelehnt' };

const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim() : null);
const amount = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);

/**
 * The receipts as the offline page lists them, newest first. Only what the list shows: no
 * receipt text, no files. Select cells are turned from option ids into their labels.
 */
export function offlineReceipts(rows: readonly Row[], columns: readonly Pick<Column, 'id' | 'name'>[], options: SelectOptionsByColumn): OfflineReceipt[] {
  const byName = firstColumnIdByName(columns);
  const cell = (row: Row, name: string): unknown => {
    const id = byName.get(name);
    return id ? row.cells[id] : undefined;
  };
  const label = (row: Row, name: string): string | null => {
    const id = byName.get(name);
    const value = id ? row.cells[id] : undefined;
    if (!id || typeof value !== 'string') return null;
    return options.get(id)?.find((o) => o.id === value)?.name ?? null;
  };
  return rows
    .filter((row) => !row.archived)
    .map((row): OfflineReceipt => {
      const gross = amount(cell(row, 'Gross'));
      const rate = amount(cell(row, 'FX Rate'));
      const currency = label(row, 'Currency');
      const status = label(row, 'Status');
      const date = text(cell(row, 'Date'));
      return {
        id: row.id,
        date: date && /^\d{4}-\d{2}-\d{2}/.test(date) ? date.slice(0, 10) : null,
        name: text(cell(row, 'Name')),
        vendor: text(cell(row, 'Vendor')),
        gross,
        currency,
        // Like the overview: no rate means the amount is already in euro.
        eur: amount(cell(row, 'EUR Equivalent')) ?? (gross === null ? null : Math.round(gross * (rate ?? 1) * 100) / 100),
        category: label(row, 'Category'),
        status: status ? (STATUS_LABELS[status] ?? status) : null,
        assignment: label(row, 'Zuordnung'),
      };
    })
    .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));
}

/** Every receipt of the workspace for the offline page; an empty list before the receipts table exists. */
export async function loadOfflineReceipts(db: PrismaClient, workspaceId: string): Promise<OfflineReceipt[]> {
  const ctx = await timed('offline.table', () => tableContext(db, workspaceId));
  if (!ctx) return [];
  // Status is read here only: adding it to `tableContext` would add a query to every page that uses it.
  const options: SelectOptionsByColumn = new Map(ctx.selectOptions);
  const status = ctx.columns.find((c) => c.name === 'Status');
  const [rows] = await Promise.all([
    timed('offline.rows', () => allReceiptRows(ctx.adapter, ctx.tableId, ctx.columns)),
    status ? ctx.adapter.getSelectOptions(status.id).then((list) => void options.set(status.id, list)) : undefined,
  ]);
  return offlineReceipts(rows, ctx.columns, options);
}
