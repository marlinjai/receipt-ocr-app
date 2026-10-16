import 'server-only';
import type { PrismaClient } from '@prisma/client';
import type { Column, Row } from '@marlinjai/data-table-core';
import { withFollowingName } from '@/lib/receipt-name-cells';
import { firstColumnIdByName } from '@/lib/column-lookup';
import { isoDay, type SelectOptionsByColumn } from '@/lib/meals/record';
import { allReceiptRows, tableContext } from '@/lib/meals/service';
import { isGroupRow } from '@/lib/receipts-kind';
import { parseTaxLines, serializeTaxLines } from '@/lib/meals/rules';
import { MEAL_CATEGORY, MEAL_COLUMNS } from '@/lib/receipts-constants';
import { kontoFor, newReading, type NewReading, type ReadingChange, type ReadingField, type StoredReading } from './reading';
import { isConfirmable, isReadFlag, lookAlikes, paymentsCoverTotal, reviewReasons, type ReadFlag, type ReviewReason, type ReviewSnapshot } from './reasons';
import { countedReceiptLinks, loadPayments } from '@/lib/tax/payments/service';
import { getFxRate } from '@/lib/fx-rates';
import { orderedRates, withTaxRates } from '@/lib/tax-rates';
import { rowsWithOwnTreatment } from '@/lib/tax/service';

/**
 * The review queue of a workspace: every receipt that needs a person's eye,
 * with the reasons, built from the receipts as they are stored now plus what
 * the reader recorded and what a person has already settled.
 *
 * Nothing in here trusts a row id from the browser: every write first checks
 * that the row lives in this workspace's Receipts table.
 */

export interface ReviewContext {
  workspaceId: string;
  tenantId: string | null;
}

export class ReviewError extends Error {
  code: 'not_initialized' | 'row_not_found';
  constructor(code: ReviewError['code']) {
    super(code);
    this.name = 'ReviewError';
    this.code = code;
  }
}

/** The fields that hold money: they mean nothing without the currency they were read in. */
const AMOUNT_FIELDS: readonly ReadingField[] = ['gross', 'net', 'tip'];

/** The exchange rate of a currency to euros on a day; null when it cannot be determined. See `getFxRate`. */
export type FxRateLookup = (currency: string, isoDate: string | null) => Promise<number | null>;

export interface ReviewEntry {
  rowId: string;
  name: string;
  vendor: string;
  /** ISO day, or null. */
  date: string | null;
  gross: number | null;
  currency: string;
  /** True when the receipt is filed as a business meal (it then also sits in the meal queue). */
  isMeal: boolean;
  reasons: ReviewReason[];
  /** True when at least one reason is a recorded doubt that "Geprüft" settles. */
  canConfirm: boolean;
  /** The receipts this one looks like, for the "same purchase?" decision. */
  duplicates: Array<{ rowId: string; name: string; date: string | null; gross: number | null }>;
  /** What a new reading of the stored text would change, field by field. Empty when nothing. */
  proposal: ReadingChange[];
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function snapshotOf(
  row: Row,
  columns: Column[],
  selectOptions: SelectOptionsByColumn,
  hashes: ReadonlyMap<string, string[]>,
): ReviewSnapshot & { isMeal: boolean; fxRate: number | null; cells: Record<string, unknown>; reading: StoredReading } {
  const byName = firstColumnIdByName(columns);
  const cell = (name: string): unknown => {
    const id = byName.get(name);
    return id ? row.cells[id] : undefined;
  };
  const optionName = (name: string): string | null => {
    const id = byName.get(name);
    const value = id ? row.cells[id] : null;
    if (!id || typeof value !== 'string' || !value) return null;
    return selectOptions.get(id)?.find((o) => o.id === value)?.name ?? null;
  };
  const files = cell('Receipt Image');
  const vendor = text(cell('Vendor')).trim();
  const category = optionName('Category');
  return {
    rowId: row.id,
    name: text(cell('Name')).trim() || vendor || 'Beleg ohne Namen',
    vendor,
    date: isoDay(cell('Date')),
    gross: numberOrNull(cell('Gross')),
    net: numberOrNull(cell('Net')),
    taxRate: numberOrNull(cell('Tax Rate')),
    currency: optionName('Currency') ?? 'EUR',
    fxRate: numberOrNull(cell('FX Rate')),
    hasText: text(cell('OCR Text')).trim().length > 0,
    hasFile: Array.isArray(files) && files.length > 0,
    fileHashes: hashes.get(row.id) ?? [],
    // A table without the column has nothing to answer: the field is left out.
    ...(byName.has('Zuordnung') ? { assignment: optionName('Zuordnung') } : {}),
    isMeal: category === MEAL_CATEGORY,
    cells: row.cells,
    reading: {
      name: text(cell('Name')).trim(),
      vendor,
      gross: numberOrNull(cell('Gross')),
      net: numberOrNull(cell('Net')),
      taxRate: numberOrNull(cell('Tax Rate')),
      currency: optionName('Currency'),
      tip: numberOrNull(cell(MEAL_COLUMNS.tip)),
      category,
      text: text(cell('OCR Text')),
    },
  };
}

/**
 * The new reading of a stored receipt, as far as this table can take it. A
 * currency the table has no option for (a person renamed or removed it)
 * cannot be written, so it is not offered. The amounts read in it, and the
 * name that states them, are not offered either: taken alone they would land
 * in a row that says another currency.
 */
function readingOf(
  stored: StoredReading,
  columns: Column[],
  selectOptions: SelectOptionsByColumn,
  /** The row's stored tax lines, and whether it is a meal: a meal's typed lines are the person's answer. */
  row: { isMeal: boolean; cells: Record<string, unknown> },
): NewReading {
  const read = newReading(stored);
  // A rate the reading brings without lines of its own is not offered against
  // the tax lines a person typed for a meal: the person's lines decide its rate.
  const linesId = firstColumnIdByName(columns).get(MEAL_COLUMNS.taxLines);
  const storedLines = linesId ? parseTaxLines(row.cells[linesId]) : null;
  const rateOffer = read.changes.find((c) => c.field === 'taxRate');
  const linesDecide = row.isMeal && read.taxLines.length === 0 && rateOffer !== undefined && Boolean(storedLines?.length) && orderedRates(storedLines)[0] !== Number(rateOffer.to);
  const reading = linesDecide ? { ...read, changes: read.changes.filter((c) => c.field !== 'taxRate') } : read;
  const currency = reading.changes.find((c) => c.field === 'currency');
  if (!currency) return reading;
  const columnId = firstColumnIdByName(columns).get('Currency');
  const options = columnId ? (selectOptions.get(columnId) ?? []) : [];
  if (options.some((o) => o.name === currency.to)) return reading;
  const boundToCurrency = (c: ReadingChange) => c.field === 'currency' || c.field === 'name' || AMOUNT_FIELDS.includes(c.field);
  return { ...reading, changes: reading.changes.filter((c) => !boundToCurrency(c)) };
}

/** Content hashes of the files on the given rows, by row. */
async function fileHashesByRow(db: PrismaClient, rowIds: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (rowIds.length === 0) return out;
  const refs = await db.dtFile.findMany({ where: { rowId: { in: rowIds } }, select: { rowId: true, metadata: true } });
  for (const ref of refs) {
    const meta = ref.metadata && typeof ref.metadata === 'object' && !Array.isArray(ref.metadata) ? (ref.metadata as Record<string, unknown>) : {};
    if (typeof meta.sha256 === 'string' && meta.sha256) out.set(ref.rowId, [...(out.get(ref.rowId) ?? []), meta.sha256]);
  }
  return out;
}

/**
 * What the payments linked to each receipt add up to, in euro cents: money out
 * less money back, a payment and the debit that funds it counted once (see
 * `countedReceiptLinks`). A failure to load them is logged and settles no
 * doubt: the review list then shows the doubts as recorded.
 */
async function paidByRow(db: PrismaClient, workspaceId: string, rowIds: readonly string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (rowIds.length === 0) return out;
  try {
    // The payments are loaded only where a receipt in doubt has a link at all.
    const linked = await db.taxPaymentLink.count({ where: { authWorkspaceId: workspaceId, rowId: { in: [...rowIds] } } });
    if (linked === 0) return out;
    const loaded = await loadPayments(db, workspaceId);
    for (const { payment, link } of countedReceiptLinks(loaded.payments)) {
      out.set(link.rowId, (out.get(link.rowId) ?? 0) + (payment.amountCents < 0 ? link.cents : -link.cents));
    }
  } catch (err) {
    console.error('[review] the linked payments could not be read:', err instanceof Error ? err.name : 'error');
  }
  return out;
}

/** Every receipt of the workspace that needs a look, oldest receipt first, undated ones last. */
export async function loadReviewQueue(db: PrismaClient, workspaceId: string): Promise<ReviewEntry[]> {
  const ctx = await tableContext(db, workspaceId);
  if (!ctx) return [];
  // Receipts only: a group has no amount, vendor or file and would sit in this list forever.
  const rows = await allReceiptRows(ctx.adapter, ctx.tableId, ctx.columns);
  if (rows.length === 0) return [];
  const rowIds = rows.map((r) => r.id);
  const [hashes, stored] = await Promise.all([
    fileHashesByRow(db, rowIds),
    db.receiptReview.findMany({ where: { authWorkspaceId: workspaceId, rowId: { in: rowIds } } }),
  ]);
  // Only a receipt with an open doubt about its total (or one read from its image alone) needs its payments.
  const inDoubt = stored.filter((r) => !r.checkedAt && r.flags.some((f) => f === 'total_unconfirmed' || f === 'total_conflict' || f === 'image_only')).map((r) => r.rowId);
  const paid = await paidByRow(db, workspaceId, inDoubt);
  const storedByRow = new Map(stored.map((r) => [r.rowId, r]));
  const distinct = new Map(stored.map((r) => [r.rowId, new Set(r.distinctFrom)]));
  const read = rows.map((row) => snapshotOf(row, ctx.columns, ctx.selectOptions, hashes));
  // Who bears a receipt is settled without the assignment column where the
  // meal register judges it or the tax side holds a decision or a vendor rule.
  const treated = await rowsWithOwnTreatment(db, workspaceId, read);
  const snapshots = read.map((s) => ({
    ...s,
    assignmentSettled: s.isMeal || treated.has(s.rowId),
    totalPaid: paymentsCoverTotal(paid.get(s.rowId) ?? 0, s),
  }));
  const byId = new Map(snapshots.map((s) => [s.rowId, s]));
  const alike = lookAlikes(snapshots, distinct);

  const entries: ReviewEntry[] = [];
  for (const s of snapshots) {
    const duplicates = alike.get(s.rowId) ?? [];
    const record = storedByRow.get(s.rowId);
    // Reading the stored text again costs nothing (no model is asked); a confirmed receipt is left alone.
    const proposal = record?.checkedAt ? [] : readingOf(s.reading, ctx.columns, ctx.selectOptions, { isMeal: s.isMeal, cells: s.cells }).changes;
    const reasons = reviewReasons(s, record, duplicates, proposal.length > 0);
    if (reasons.length === 0) continue;
    entries.push({
      rowId: s.rowId,
      name: s.name,
      vendor: s.vendor,
      date: s.date,
      gross: s.gross,
      currency: s.currency,
      isMeal: s.isMeal,
      reasons,
      canConfirm: reasons.some(isConfirmable),
      duplicates: duplicates
        .map((id) => byId.get(id))
        .filter((d): d is NonNullable<typeof d> => d !== undefined)
        .map((d) => ({ rowId: d.rowId, name: d.name, date: d.date, gross: d.gross })),
      proposal,
    });
  }
  return entries.sort((a, b) => {
    if (a.date !== b.date) return (a.date ?? '9999') < (b.date ?? '9999') ? -1 : 1;
    return a.rowId < b.rowId ? -1 : 1;
  });
}

async function requireRow(db: PrismaClient, ctx: ReviewContext, rowId: string): Promise<void> {
  const table = await tableContext(db, ctx.workspaceId);
  if (!table) throw new ReviewError('not_initialized');
  const row = await table.adapter.getRow(rowId);
  if (!row || row.tableId !== table.tableId || isGroupRow(row, table.columns)) throw new ReviewError('row_not_found');
}

/**
 * Record what the reader could not settle about a receipt it just read. A new
 * reading replaces the old doubts and reopens the receipt for confirmation;
 * the look-alike decisions a person made stay.
 */
export async function recordReadFlags(
  db: PrismaClient,
  ctx: ReviewContext,
  rowId: string,
  flags: readonly ReadFlag[],
  /** The total the reading stored, so a later correction of it ends a doubt about it. */
  readGross: number | null = null,
): Promise<void> {
  const clean = [...new Set(flags.filter(isReadFlag))];
  const readGrossCents = readGross !== null && Number.isFinite(readGross) ? Math.round(readGross * 100) : null;
  if (clean.length === 0) {
    // Nothing to doubt: drop stale doubts of an earlier reading, keep the decisions.
    await db.receiptReview.updateMany({ where: { rowId, authWorkspaceId: ctx.workspaceId }, data: { flags: [], checkedAt: null, readGrossCents } });
    return;
  }
  await db.receiptReview.upsert({
    where: { rowId },
    create: { rowId, authWorkspaceId: ctx.workspaceId, authTenantId: ctx.tenantId, flags: clean, readGrossCents },
    update: { flags: clean, checkedAt: null, readGrossCents },
  });
}

/** A person looked at the receipt and it is right: the recorded doubts are settled. */
export async function confirmReceipt(db: PrismaClient, ctx: ReviewContext, rowId: string, now: () => Date = () => new Date()): Promise<void> {
  await requireRow(db, ctx, rowId);
  await db.receiptReview.upsert({
    where: { rowId },
    create: { rowId, authWorkspaceId: ctx.workspaceId, authTenantId: ctx.tenantId, checkedAt: now() },
    update: { checkedAt: now() },
  });
}

/** A person decided two look-alike receipts are different purchases. Stored on both, so it holds whichever is opened. */
export async function keepBothReceipts(db: PrismaClient, ctx: ReviewContext, rowId: string, otherRowId: string): Promise<void> {
  if (rowId === otherRowId) throw new ReviewError('row_not_found');
  await requireRow(db, ctx, rowId);
  await requireRow(db, ctx, otherRowId);
  for (const [a, b] of [
    [rowId, otherRowId],
    [otherRowId, rowId],
  ]) {
    const existing = await db.receiptReview.findUnique({ where: { rowId: a }, select: { distinctFrom: true } });
    const distinctFrom = [...new Set([...(existing?.distinctFrom ?? []), b])];
    await db.receiptReview.upsert({
      where: { rowId: a },
      create: { rowId: a, authWorkspaceId: ctx.workspaceId, authTenantId: ctx.tenantId, distinctFrom },
      update: { distinctFrom },
    });
  }
}

/**
 * Take the new reading of a stored receipt, for the fields named. The values
 * are read again here from the stored text; nothing the browser sends is
 * written, and a field whose reading no longer differs is skipped. Returns
 * the fields that were written.
 *
 * A new currency brings its exchange rate, looked up for the receipt's day by
 * `fxRateFor`: the one lookup the upload and "Recompute FX" use, so the row
 * ends up as a fresh upload of the same receipt would leave it.
 */
export async function applyNewReading(
  db: PrismaClient,
  ctx: ReviewContext,
  rowId: string,
  fields: readonly ReadingField[],
  fxRateFor: FxRateLookup = getFxRate,
): Promise<ReadingField[]> {
  const table = await tableContext(db, ctx.workspaceId);
  if (!table) throw new ReviewError('not_initialized');
  const row = await table.adapter.getRow(rowId);
  // A group is never read: it has no file and takes no amount.
  if (!row || row.tableId !== table.tableId || isGroupRow(row, table.columns)) throw new ReviewError('row_not_found');

  const snapshot = snapshotOf(row, table.columns, table.selectOptions, new Map());
  const reading = readingOf(snapshot.reading, table.columns, table.selectOptions, { isMeal: snapshot.isMeal, cells: row.cells });
  const wanted = new Set(fields);
  // An amount is read in the receipt's currency: 360 dollars taken into a row
  // that still says euros would be a wrong amount. Whoever takes an amount
  // takes the currency it was read in with it.
  if (AMOUNT_FIELDS.some((f) => wanted.has(f))) wanted.add('currency');
  const linesColumn = firstColumnIdByName(table.columns).get(MEAL_COLUMNS.taxLines);
  const storedLines = linesColumn ? parseTaxLines(row.cells[linesColumn]) : null;
  // `readingOf` offers no rate against a meal's typed lines, so none is taken here either.
  const rateOffer = reading.changes.find((c) => c.field === 'taxRate');
  const take = reading.changes.filter((c) => wanted.has(c.field));
  if (take.length === 0) return [];
  // A total or a net taken brings the printed tax lines with it (below), and
  // those bring the rate read with them: a rate left behind would name
  // another first rate than the lines do.
  if (rateOffer && !wanted.has('taxRate') && reading.taxLines.length > 0 && take.some((c) => c.field === 'gross' || c.field === 'net')) take.push(rateOffer);

  const byName = firstColumnIdByName(table.columns);
  const columnId = (name: string): string => {
    const id = byName.get(name);
    if (!id) throw new ReviewError('not_initialized');
    return id;
  };
  const cells: Record<string, string | number | null> = {};
  for (const change of take) {
    if (change.field === 'name') cells[columnId('Name')] = change.to;
    if (change.field === 'vendor') cells[columnId('Vendor')] = change.to;
    if (change.field === 'gross') cells[columnId('Gross')] = change.to;
    if (change.field === 'net') cells[columnId('Net')] = change.to;
    if (change.field === 'taxRate') cells[columnId('Tax Rate')] = change.to;
    if (change.field === 'tip') cells[columnId(MEAL_COLUMNS.tip)] = change.to;
    if (change.field === 'currency') {
      const id = columnId('Currency');
      const option = table.selectOptions.get(id)?.find((o) => o.name === change.to);
      if (!option) throw new ReviewError('not_initialized');
      cells[id] = option.id;
      // The rate of the receipt's own day, as the row shows it. Blank when it
      // cannot be determined (no date, lookup failed), never a guessed rate.
      cells[columnId('FX Rate')] = await fxRateFor(String(change.to), snapshot.date);
    }
    if (change.field === 'category') {
      const id = columnId('Category');
      const option = table.selectOptions.get(id)?.find((o) => o.name === change.to);
      if (!option) throw new ReviewError('not_initialized');
      cells[id] = option.id;
      cells[columnId('Konto')] = kontoFor(String(change.to));
    }
  }
  // The printed tax groups go with the amounts, so a meal's tax split in the register matches the new
  // total. A receipt that is no meal keeps them too: they are what its rates text is derived from.
  const amountsTaken = take.some((c) => c.field === 'gross' || c.field === 'net' || c.field === 'taxRate');
  const rateChange = take.find((c) => c.field === 'taxRate');
  const rateTaken = rateChange ? Number(rateChange.to) : undefined;
  if (amountsTaken && reading.taxLines.length > 0) {
    cells[columnId(MEAL_COLUMNS.taxLines)] = serializeTaxLines(reading.taxLines);
  } else if (rateTaken !== undefined && linesColumn && storedLines?.length && orderedRates(storedLines)[0] !== rateTaken) {
    // A rate taken without lines of its own on a receipt that is no meal: the
    // stored lines are the printed groups of an older reading and contradict
    // it, so they go and the two rate columns name the same first rate.
    cells[linesColumn] = serializeTaxLines(null);
  }
  // A vendor or a total taken from the proposal is said by the name too, unless the proposal names the receipt itself.
  const named = await withFollowingName(table.adapter, table.columns, cells, row.cells);
  await table.adapter.updateRow(rowId, withTaxRates(table.columns, named, row.cells));
  // A vendor or category taken from the reading may move the receipt under a vendor
  // rule or into the meal register: its assignment cells follow (loaded on demand,
  // that module reads receipts through the meal service).
  if (take.some((c) => c.field === 'vendor' || c.field === 'category')) {
    const { followTreatment } = await import('@/lib/tax/assignment-sync');
    await followTreatment(db, ctx, { rowIds: [rowId] });
  }
  return take.map((c) => c.field);
}
