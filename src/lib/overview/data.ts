import 'server-only';
import { PrismaAdapter } from '@marlinjai/data-table-adapter-prisma';
import type { Row, Column } from '@marlinjai/data-table-core';
import { prisma } from '@/lib/prisma';
import { aggregateOverview, type InvoiceRecord, type OverviewData } from './aggregate';

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

/** The full aggregated overview for a workspace (empty if no Receipts table). */
export async function loadOverview(workspaceId: string): Promise<OverviewData> {
  const adapter = new PrismaAdapter({ prisma });
  const table = await receiptsTable(adapter, workspaceId);
  if (!table) return aggregateOverview([]);

  const columns: Column[] = await adapter.getColumns(table.id);
  const col = (name: string) => columns.find((c) => c.name === name);
  const vendorCol = col('Vendor');
  const grossCol = col('Gross');
  const fxCol = col('FX Rate');
  const shareCol = col('Business Share %');
  const dateCol = col('Date');
  const currencyCol = col('Currency');

  const currencyOpts = currencyCol ? await adapter.getSelectOptions(currencyCol.id) : [];
  const currencyName = new Map(currencyOpts.map((o) => [o.id, o.name]));

  const rows = await allRows(adapter, table.id);
  const invoices: InvoiceRecord[] = rows.map((r) => {
    const cells = r.cells;
    const curId = currencyCol ? cells[currencyCol.id] : null;
    const currency = (typeof curId === 'string' ? currencyName.get(curId) : null) ?? 'EUR';
    return {
      vendor: (vendorCol ? str(cells[vendorCol.id]) : null) ?? 'Unknown',
      currency,
      amountNative: grossCol ? num(cells[grossCol.id]) : 0,
      fxRate: fxCol ? num(cells[fxCol.id]) || 1 : 1,
      businessShare: shareCol && cells[shareCol.id] != null ? num(cells[shareCol.id]) : 100,
      date: dateCol ? str(cells[dateCol.id]) : null,
    };
  });

  return aggregateOverview(invoices);
}
