import type { PrismaClient } from '@prisma/client';
import { loadStatement } from '@/lib/tax/service';
import { RECEIPTS_TABLE_NAME } from '@/lib/receipts-table';

/**
 * Every computed figure of the finance area, for every workspace and every
 * year it has: the totals the owner reads (business expenses, receipts
 * counted, employment annex) and, so that two runs can be proven equal down to
 * the item, every line of the statement and every item's counted parts and
 * open checks. Display-only facts (where a treatment came from, labels) are
 * left out on purpose: they may change without any figure changing.
 *
 * Used by the equality check of the assignment-cell migration, which runs it on
 * a local copy of production before and after the migration.
 */

export interface YearFigures {
  businessExpenseCents: number;
  countedItems: number;
  employmentCostCents: number;
  privateCents: number;
  blockedItems: number;
  businessRevenueCents: number;
  profitCents: number | null;
  lines: Array<{ key: string; cents: number; nonDeductibleCents: number; items: string[] }>;
  items: Array<{
    itemId: string;
    counted: boolean;
    amountCents: number | null;
    allocations: unknown;
    formLineKey: string | null;
    employmentLineKey: string | null;
    parts: unknown;
    privateCents: number;
    checks: string[];
  }>;
}

export type Figures = Record<string, Record<number, YearFigures>>;

export async function financeFigures(db: PrismaClient): Promise<Figures> {
  const tables = await db.dtTable.findMany({ where: { name: RECEIPTS_TABLE_NAME }, select: { workspaceId: true }, orderBy: { workspaceId: 'asc' } });
  const out: Figures = {};
  for (const { workspaceId } of tables) {
    const first = await loadStatement(db, workspaceId, new Date().getUTCFullYear());
    const years = [...new Set(first.years)].sort();
    out[workspaceId] = {};
    for (const year of years) {
      const s = await loadStatement(db, workspaceId, year);
      out[workspaceId][year] = {
        businessExpenseCents: s.businessExpenseCents,
        countedItems: s.countedItems,
        employmentCostCents: s.employmentCostCents,
        privateCents: s.privateCents,
        blockedItems: s.blockedItems,
        businessRevenueCents: s.businessRevenueCents,
        profitCents: s.profitCents,
        lines: s.lines.map((l) => ({ key: l.key, cents: l.cents, nonDeductibleCents: l.nonDeductibleCents, items: [...l.itemIds].sort() })),
        items: s.items
          .map((i) => ({
            itemId: i.itemId,
            counted: i.counted,
            amountCents: i.amountCents,
            allocations: i.allocations,
            formLineKey: i.formLineKey,
            employmentLineKey: i.employmentLineKey,
            parts: i.parts,
            privateCents: i.privateCents,
            checks: i.checks.map((c) => JSON.stringify(c)).sort(),
          }))
          .sort((a, b) => a.itemId.localeCompare(b.itemId)),
      };
    }
  }
  return out;
}

/** The three totals per workspace and year, in euros, for a human to read. */
export function summary(figures: Figures): Array<{ workspaceId: string; year: number; businessExpenses: string; counted: number; employmentAnnex: string }> {
  const euro = (cents: number) => (cents / 100).toFixed(2);
  return Object.entries(figures).flatMap(([workspaceId, years]) =>
    Object.entries(years).map(([year, f]) => ({
      workspaceId,
      year: Number(year),
      businessExpenses: euro(f.businessExpenseCents),
      counted: f.countedItems,
      employmentAnnex: euro(f.employmentCostCents),
    })),
  );
}

/**
 * The overview page's "attributed" euros (gross times "Business Share %",
 * whatever the assignment) per workspace and year. NOT a figure of the finance
 * area, and the migration moves it on purpose: a private receipt stops counting
 * as attributed, a decided one counts with its decided share. Reported beside
 * the equality check so the owner sees by how much.
 */
export async function overviewAttributed(): Promise<Record<string, Record<string, { attributedEur: string; rawEur: string; invoices: number }>>> {
  const { loadInvoices } = await import('@/lib/overview/data');
  const { aggregateOverview } = await import('@/lib/overview/aggregate');
  const { prisma } = await import('@/lib/prisma');
  const tables = await prisma.dtTable.findMany({ where: { name: RECEIPTS_TABLE_NAME }, select: { workspaceId: true } });
  const out: Record<string, Record<string, { attributedEur: string; rawEur: string; invoices: number }>> = {};
  for (const { workspaceId } of tables) {
    const invoices = await loadInvoices(workspaceId);
    const years = [...new Set(invoices.map((i) => (i.date ?? '').slice(0, 4)).filter((y) => /^\d{4}$/.test(y)))].sort();
    out[workspaceId] = {};
    for (const year of years) {
      const t = aggregateOverview(invoices.filter((i) => (i.date ?? '').startsWith(year))).totals;
      out[workspaceId][year] = { attributedEur: t.attributedEur.toFixed(2), rawEur: t.rawEur.toFixed(2), invoices: t.invoiceCount };
    }
  }
  return out;
}
