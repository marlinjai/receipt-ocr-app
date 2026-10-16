import 'server-only';
import { Prisma, type PrismaClient } from '@prisma/client';
import type { LineResult } from '../types';
import { estimateIncomeTax, type IncomeTaxEstimate } from './estimate';
import {
  decodeChurchMonths,
  encodeChurchMonths,
  validateFederalState,
  validateReturnItemInput,
  validateYearSettings,
  validateWageInput,
} from './input';
import { isReturnItemKey, type ReturnItemFact } from './return-items';
import { isFederalState, type FederalState } from './rules';
import { aggregateWages, churchMonthsFromPaySlips, type WageEntry } from './wages';

/**
 * Reads and writes for the income tax estimate.
 *
 * Every function takes the workspace explicitly, resolved by the caller from
 * the verified session, never from the browser; a row of another workspace is
 * "not found". Only stated facts are stored; the estimate is computed on read.
 */

export interface IncomeTaxContext {
  workspaceId: string;
  tenantId: string | null;
}

export type IncomeTaxServiceErrorCode = 'wage_not_found' | 'item_not_found' | 'wage_entry_taken';

export class IncomeTaxServiceError extends Error {
  readonly code: IncomeTaxServiceErrorCode;
  constructor(code: IncomeTaxServiceErrorCode) {
    super(code);
    this.name = 'IncomeTaxServiceError';
    this.code = code;
  }
}

export interface IncomeTaxView {
  year: number;
  /** The year is the running one: figures are as of today, and the wages may be projected. */
  running: boolean;
  wageEntries: WageEntry[];
  returnItems: ReturnItemFact[];
  /** The months as the owner stated them for the year; null: not stated. */
  churchMonths: boolean[] | null;
  /** What the pay slips say, offered when nothing is stated. */
  churchMonthsFromPaySlips: boolean[] | null;
  federalState: FederalState | null;
  /** The estimate with the wages as recorded. */
  estimate: IncomeTaxEstimate;
  /** The running year with pay slips projected to December; null when there is nothing to project. */
  projected: IncomeTaxEstimate | null;
}

/** What the statement of the year contributes: its result and the employment annex lines. */
export interface StatementPart {
  profitCents: number | null;
  lines: readonly LineResult[];
}

function toWageEntry(row: Prisma.TaxWageStatementGetPayload<object>): WageEntry {
  return {
    id: row.id,
    employer: row.employer,
    month: row.month,
    grossCents: row.grossCents,
    wageTaxCents: row.wageTaxCents,
    solidarityCents: row.solidarityCents,
    churchTaxCents: row.churchTaxCents,
    pensionEmployeeCents: row.pensionEmployeeCents,
    pensionEmployerCents: row.pensionEmployerCents,
    healthEmployeeCents: row.healthEmployeeCents,
    careEmployeeCents: row.careEmployeeCents,
    unemploymentEmployeeCents: row.unemploymentEmployeeCents,
    healthWithSickPay: row.healthWithSickPay,
    churchLiable: row.churchLiable,
  };
}

export async function loadIncomeTax(
  db: PrismaClient,
  workspaceId: string,
  year: number,
  statement: StatementPart,
  today: Date = new Date(),
): Promise<IncomeTaxView> {
  const [wageRows, itemRows, yearRow, settings] = await Promise.all([
    db.taxWageStatement.findMany({ where: { authWorkspaceId: workspaceId, year }, orderBy: [{ employer: 'asc' }, { month: 'asc' }] }),
    db.taxReturnItem.findMany({ where: { authWorkspaceId: workspaceId, year }, orderBy: [{ key: 'asc' }, { createdAt: 'asc' }] }),
    db.taxYearSettings.findUnique({ where: { authWorkspaceId_year: { authWorkspaceId: workspaceId, year } } }),
    db.workspaceTaxSettings.findUnique({ where: { authWorkspaceId: workspaceId }, select: { federalState: true } }),
  ]);
  const wageEntries = wageRows.map(toWageEntry);
  // A key no longer known (a rule removed later) is ignored rather than miscounted.
  const returnItems: ReturnItemFact[] = itemRows.flatMap((r) =>
    isReturnItemKey(r.key) ? [{ id: r.id, key: r.key, amountCents: r.amountCents, days: r.days, distanceKm: r.distanceKm, ownCar: r.ownCar, note: r.note }] : [],
  );
  const statedMonths = decodeChurchMonths(yearRow?.churchMonths ?? null);
  const federalState = settings?.federalState && isFederalState(settings.federalState) ? settings.federalState : null;
  // The employment annex: amount lines count as costs; the structured lines
  // (commute, home office) are replaced by the flat rates of the return items.
  const employmentLines = statement.lines.filter((l) => l.form === 'employment');
  const employmentReceiptsCents = employmentLines.filter((l) => l.numbering !== 'structured').reduce((s, l) => s + l.cents, 0);
  const employmentStructuredReceiptsCents = employmentLines.filter((l) => l.numbering === 'structured').reduce((s, l) => s + l.cents, 0);

  const running = year === today.getFullYear();
  const run = (project: boolean) => {
    const fromSlips = churchMonthsFromPaySlips(wageEntries, project);
    const churchMonths = statedMonths ?? (fromSlips && fromSlips.some(Boolean) ? fromSlips : null);
    return estimateIncomeTax({
      year,
      businessProfitCents: statement.profitCents,
      wages: aggregateWages(wageEntries, project),
      employmentReceiptsCents,
      employmentStructuredReceiptsCents,
      returnItems,
      churchMonths,
      churchMonthsBasis: statedMonths ? 'stated' : churchMonths ? 'pay_slips' : null,
      federalState,
    });
  };
  const estimate = run(false);
  const projectable = running && (aggregateWages(wageEntries, true)?.projected ?? false);
  return {
    year,
    running,
    wageEntries,
    returnItems,
    churchMonths: statedMonths,
    churchMonthsFromPaySlips: churchMonthsFromPaySlips(wageEntries, false),
    federalState,
    estimate,
    projected: projectable ? run(true) : null,
  };
}

/** Create (`wageId` null) or change a wage statement or pay slip. */
export async function saveWageEntry(db: PrismaClient, ctx: IncomeTaxContext, wageId: string | null, raw: unknown): Promise<string> {
  const input = validateWageInput(raw);
  try {
    if (wageId === null) {
      const row = await db.taxWageStatement.create({ data: { authWorkspaceId: ctx.workspaceId, authTenantId: ctx.tenantId, ...input } });
      return row.id;
    }
    const existing = await db.taxWageStatement.findFirst({ where: { id: wageId, authWorkspaceId: ctx.workspaceId }, select: { id: true } });
    if (!existing) throw new IncomeTaxServiceError('wage_not_found');
    await db.taxWageStatement.update({ where: { id: wageId }, data: input });
    return wageId;
  } catch (e) {
    // The same employer and month of a year exists already: refused, never merged silently.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new IncomeTaxServiceError('wage_entry_taken');
    throw e;
  }
}

export async function deleteWageEntry(db: PrismaClient, ctx: IncomeTaxContext, wageId: string): Promise<void> {
  const { count } = await db.taxWageStatement.deleteMany({ where: { id: wageId, authWorkspaceId: ctx.workspaceId } });
  if (count === 0) throw new IncomeTaxServiceError('wage_not_found');
}

export async function saveReturnItem(db: PrismaClient, ctx: IncomeTaxContext, itemId: string | null, raw: unknown): Promise<string> {
  const input = validateReturnItemInput(raw);
  if (itemId === null) {
    const row = await db.taxReturnItem.create({ data: { authWorkspaceId: ctx.workspaceId, authTenantId: ctx.tenantId, ...input } });
    return row.id;
  }
  const { count } = await db.taxReturnItem.updateMany({ where: { id: itemId, authWorkspaceId: ctx.workspaceId }, data: input });
  if (count === 0) throw new IncomeTaxServiceError('item_not_found');
  return itemId;
}

export async function deleteReturnItem(db: PrismaClient, ctx: IncomeTaxContext, itemId: string): Promise<void> {
  const { count } = await db.taxReturnItem.deleteMany({ where: { id: itemId, authWorkspaceId: ctx.workspaceId } });
  if (count === 0) throw new IncomeTaxServiceError('item_not_found');
}

/** The church tax months of a year; null clears the statement (then the pay slips are read). */
export async function saveChurchMonths(db: PrismaClient, ctx: IncomeTaxContext, raw: unknown): Promise<void> {
  const input = validateYearSettings(raw);
  const churchMonths = input.churchMonths === null ? null : encodeChurchMonths(input.churchMonths);
  await db.taxYearSettings.upsert({
    where: { authWorkspaceId_year: { authWorkspaceId: ctx.workspaceId, year: input.year } },
    create: { authWorkspaceId: ctx.workspaceId, authTenantId: ctx.tenantId, year: input.year, churchMonths },
    update: { churchMonths },
  });
}

export async function saveFederalState(db: PrismaClient, ctx: IncomeTaxContext, raw: unknown): Promise<void> {
  const federalState = validateFederalState(raw);
  await db.workspaceTaxSettings.upsert({
    where: { authWorkspaceId: ctx.workspaceId },
    create: { authWorkspaceId: ctx.workspaceId, authTenantId: ctx.tenantId, federalState },
    update: { federalState },
  });
}
