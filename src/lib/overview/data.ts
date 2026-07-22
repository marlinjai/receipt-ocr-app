import 'server-only';
import { PrismaAdapter } from '@marlinjai/data-table-adapter-prisma';
import type { Row, Column } from '@marlinjai/data-table-core';
import { prisma } from '@/lib/prisma';
import type { LedgerInvoice } from './selection';

const TABLE_NAME = 'Receipts';

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);

async function receiptsTable(adapter: PrismaAdapter, workspaceId: string) {
  const tables = await adapter.listTables(workspaceId);
  return tables.find((t) => t.name === TABLE_NAME) ?? null;
}

async function allRows(adapter: PrismaAdapter, tableId: string): Promise<Row[]> {
  const out: Row[] = [];
  let offset = 0;
  const limit = 500;
  for (;;) {
    const page = await adapter.getRows(tableId, { limit, offset });
    out.push(...page.items);
    if (!page.hasMore || page.items.length === 0) break;
    offset += page.items.length;
  }
  return out;
}

/**
 * The workspace's ledger as normalized invoice records (with row identity for
 * the picker). Aggregation happens CLIENT-side over these, so time-frame and
 * selection controls re-chart instantly without a round trip.
 */
export async function loadInvoices(workspaceId: string): Promise<LedgerInvoice[]> {
  const adapter = new PrismaAdapter({ prisma });
  const table = await receiptsTable(adapter, workspaceId);
  if (!table) return [];

  const columns: Column[] = await adapter.getColumns(table.id);
  const col = (name: string) => columns.find((c) => c.name === name);
  const nameCol = col('Name');
  const vendorCol = col('Vendor');
  const grossCol = col('Gross');
  const fxCol = col('FX Rate');
  const shareCol = col('Business Share %');
  const dateCol = col('Date');
  const currencyCol = col('Currency');

  const currencyOpts = currencyCol ? await adapter.getSelectOptions(currencyCol.id) : [];
  const currencyName = new Map(currencyOpts.map((o) => [o.id, o.name]));

  const rows = await allRows(adapter, table.id);
  return rows.map((r) => {
    const cells = r.cells;
    const curId = currencyCol ? cells[currencyCol.id] : null;
    const currency = (typeof curId === 'string' ? currencyName.get(curId) : null) ?? 'EUR';
    return {
      id: r.id,
      name: nameCol ? str(cells[nameCol.id]) : null,
      vendor: (vendorCol ? str(cells[vendorCol.id]) : null) ?? 'Unknown',
      currency,
      amountNative: grossCol ? num(cells[grossCol.id]) : 0,
      fxRate: fxCol ? num(cells[fxCol.id]) || 1 : 1,
      businessShare: shareCol && cells[shareCol.id] != null ? num(cells[shareCol.id]) : 100,
      date: dateCol ? str(cells[dateCol.id]) : null,
    };
  });
}
