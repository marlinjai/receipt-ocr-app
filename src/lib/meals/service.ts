import 'server-only';
import { PrismaAdapter } from '@marlinjai/data-table-adapter-prisma';
import type { CellValue, Column, Row } from '@marlinjai/data-table-core';
import type { PrismaClient } from '@prisma/client';
import { PrismaContactStore } from '@/lib/contacts/prisma-store';
import type { ContactStore } from '@/lib/contacts/store';
import {
  MEAL_COLUMNS,
  consumptionLabel,
  mealTypeLabel,
} from '@/lib/receipts-constants';
import { inputFromRecord, normalizeMealInput, sameMealInput, type MealDetailsInput } from './input';
import { rowToMealRecord, type SelectOptionsByColumn } from './record';
import { isMealRelated, serializeTaxLines } from './rules';
import { DEFAULT_TAX_SETTINGS, type MealGuestEntry, type MealRecord, type MealTaxSettings } from './types';

/**
 * Server-side reads and writes for the meal register.
 *
 * Every function takes the workspace explicitly (`MealContext`), resolved by
 * the caller from the verified session and never from anything the browser
 * sent. A row is only ever addressed through the workspace's own Receipts
 * table, so a row id from another workspace behaves like one that does not
 * exist. That makes this module testable against a real database without the
 * auth stack.
 */

const TABLE_NAME = 'Receipts';
const SELECT_COLUMNS = ['Category', 'Zuordnung', 'Currency', MEAL_COLUMNS.mealType, MEAL_COLUMNS.consumption];

export interface MealContext {
  workspaceId: string;
  /** Stamped on created rows; null only for the development bypass. */
  tenantId: string | null;
}

export type MealServiceErrorCode =
  | 'not_initialized'
  | 'row_not_found'
  | 'unknown_contact'
  | 'archived_contact'
  | 'schema_outdated';

export class MealServiceError extends Error {
  readonly code: MealServiceErrorCode;
  constructor(code: MealServiceErrorCode, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'MealServiceError';
    this.code = code;
  }
}

export interface TableContext {
  adapter: PrismaAdapter;
  tableId: string;
  columns: Column[];
  selectOptions: SelectOptionsByColumn;
}

/** The workspace's Receipts table with its columns and select options, or null before the first dashboard visit. */
export async function tableContext(db: PrismaClient, workspaceId: string): Promise<TableContext | null> {
  const adapter = new PrismaAdapter({ prisma: db });
  const tables = await adapter.listTables(workspaceId);
  const table = tables.find((t) => t.name === TABLE_NAME);
  if (!table) return null;
  const columns = await adapter.getColumns(table.id);
  const selectOptions: SelectOptionsByColumn = new Map();
  await Promise.all(
    columns
      .filter((c) => SELECT_COLUMNS.includes(c.name))
      .map(async (c) => {
        selectOptions.set(c.id, await adapter.getSelectOptions(c.id));
      }),
  );
  return { adapter, tableId: table.id, columns, selectOptions };
}

export async function allRows(adapter: PrismaAdapter, tableId: string): Promise<Row[]> {
  const out: Row[] = [];
  let offset = 0;
  const limit = 500;
  for (;;) {
    const page = await adapter.getRows(tableId, { limit, offset, include: ['files'] });
    out.push(...page.items);
    if (!page.hasMore || page.items.length === 0) break;
    offset += page.items.length;
  }
  return out;
}

export async function guestsByRow(
  db: PrismaClient,
  workspaceId: string,
  rowIds: string[],
): Promise<Map<string, MealGuestEntry[]>> {
  const out = new Map<string, MealGuestEntry[]>();
  if (rowIds.length === 0) return out;
  const guests = await db.mealGuest.findMany({
    where: { authWorkspaceId: workspaceId, rowId: { in: rowIds } },
    orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
  });
  for (const g of guests) {
    const list = out.get(g.rowId) ?? [];
    list.push({ contactId: g.contactId, name: g.displayName, company: g.displayCompany });
    out.set(g.rowId, list);
  }
  return out;
}

export function contactStore(db: PrismaClient, ctx: MealContext): ContactStore {
  return new PrismaContactStore(db, ctx.workspaceId, ctx.tenantId);
}

/**
 * Every row of the workspace that has anything to do with the register: the
 * register entries, the incomplete ones, and the meals recorded separately.
 * Rows of other categories are left out.
 */
export async function loadMealRecords(db: PrismaClient, workspaceId: string): Promise<MealRecord[]> {
  const ctx = await tableContext(db, workspaceId);
  if (!ctx) return [];
  const rows = await allRows(ctx.adapter, ctx.tableId);
  const noGuests: MealGuestEntry[] = [];
  const candidates = rows
    .filter((r) => !r.archived)
    .map((r) => rowToMealRecord(r, ctx.columns, ctx.selectOptions, noGuests))
    .filter(isMealRelated);
  const guests = await guestsByRow(db, workspaceId, candidates.map((r) => r.rowId));
  return candidates.map((r) => ({ ...r, guests: guests.get(r.rowId) ?? [] }));
}

/** One row as a meal record, whatever its category. Null when the row is not in this workspace. */
export async function loadMealRecord(
  db: PrismaClient,
  workspaceId: string,
  rowId: string,
): Promise<MealRecord | null> {
  const ctx = await tableContext(db, workspaceId);
  if (!ctx) return null;
  return loadWithContext(db, workspaceId, ctx, rowId);
}

/**
 * Assumption worth knowing: `adapter.getRow` only searches tables the adapter
 * has migrated to their own physical table. Every Receipts table is migrated
 * the first time its rows are listed (`getRows` does it), and nothing reaches
 * a single meal without the dashboard or the meals page having listed rows
 * first, so this holds in practice. A row in a never-listed table reads as
 * "not found", which is the safe direction.
 */
async function loadWithContext(
  db: PrismaClient,
  workspaceId: string,
  ctx: TableContext,
  rowId: string,
): Promise<MealRecord | null> {
  const row = await ctx.adapter.getRow(rowId);
  // The row must live in THIS workspace's Receipts table.
  if (!row || row.tableId !== ctx.tableId) return null;
  const guests = await guestsByRow(db, workspaceId, [rowId]);
  return rowToMealRecord(row, ctx.columns, ctx.selectOptions, guests.get(rowId) ?? []);
}

export interface SaveMealResult {
  record: MealRecord;
  /** False when the input equals what is stored: nothing was written, the timestamp is untouched. */
  changed: boolean;
}

/**
 * Save the meal details of one row.
 *
 * Saving the same inputs again writes nothing (not even the timestamp), so
 * reopening and confirming an entry does not make it look freshly edited.
 */
export async function saveMealDetails(
  db: PrismaClient,
  mealCtx: MealContext,
  rowId: string,
  rawInput: MealDetailsInput,
  now: () => Date = () => new Date(),
): Promise<SaveMealResult> {
  const input = normalizeMealInput(rawInput);
  const ctx = await tableContext(db, mealCtx.workspaceId);
  if (!ctx) throw new MealServiceError('not_initialized');
  const current = await loadWithContext(db, mealCtx.workspaceId, ctx, rowId);
  if (!current) throw new MealServiceError('row_not_found');

  // The form leaves date and gross alone unless it was shown them empty.
  const stored = inputFromRecord(current);
  const merged: MealDetailsInput = {
    ...input,
    date: input.date ?? stored.date,
    gross: input.gross ?? stored.gross,
  };
  if (sameMealInput(merged, stored)) return { record: current, changed: false };

  // Guests: every id must be a contact of this workspace. An archived contact
  // may stay on a meal it is already on, but cannot be newly added.
  const store = contactStore(db, mealCtx);
  const contacts = await store.getMany(merged.guestContactIds);
  const contactById = new Map(contacts.map((c) => [c.id, c]));
  const alreadyOnMeal = new Set(current.guests.map((g) => g.contactId));
  for (const id of merged.guestContactIds) {
    const contact = contactById.get(id);
    if (!contact) throw new MealServiceError('unknown_contact', id);
    if (contact.archived && !alreadyOnMeal.has(id)) throw new MealServiceError('archived_contact', id);
  }

  const columnId = (name: string): string => {
    const col = ctx.columns.find((c) => c.name === name);
    if (!col) throw new MealServiceError('schema_outdated', name);
    return col.id;
  };
  const optionId = (columnName: string, optionName: string | null): string | null => {
    if (optionName === null) return null;
    const id = ctx.selectOptions.get(columnId(columnName))?.find((o) => o.name === optionName)?.id;
    if (!id) throw new MealServiceError('schema_outdated', `${columnName}: ${optionName}`);
    return id;
  };

  const cells: Record<string, CellValue> = {
    [columnId(MEAL_COLUMNS.mealType)]: optionId(
      MEAL_COLUMNS.mealType,
      merged.mealType ? mealTypeLabel(merged.mealType) : null,
    ),
    [columnId(MEAL_COLUMNS.occasion)]: merged.occasion,
    [columnId(MEAL_COLUMNS.place)]: merged.place,
    [columnId(MEAL_COLUMNS.host)]: merged.host,
    [columnId(MEAL_COLUMNS.tip)]: merged.tip,
    [columnId(MEAL_COLUMNS.consumption)]: optionId(
      MEAL_COLUMNS.consumption,
      merged.consumption ? consumptionLabel(merged.consumption) : null,
    ),
    [columnId(MEAL_COLUMNS.taxLines)]: serializeTaxLines(merged.taxLines),
    [columnId(MEAL_COLUMNS.detailsAt)]: now().toISOString(),
  };
  if (merged.date !== stored.date) cells[columnId('Date')] = merged.date;
  if (merged.gross !== null && merged.gross !== stored.gross) cells[columnId('Gross')] = merged.gross;

  await ctx.adapter.updateRow(rowId, cells);

  const guestsChanged =
    JSON.stringify(merged.guestContactIds) !== JSON.stringify(current.guests.map((g) => g.contactId));
  if (guestsChanged) {
    await db.$transaction([
      db.mealGuest.deleteMany({ where: { authWorkspaceId: mealCtx.workspaceId, rowId } }),
      db.mealGuest.createMany({
        data: merged.guestContactIds.map((contactId, position) => {
          const contact = contactById.get(contactId)!;
          return {
            authWorkspaceId: mealCtx.workspaceId,
            authTenantId: mealCtx.tenantId,
            rowId,
            contactId,
            position,
            displayName: contact.name,
            displayCompany: contact.companyOrRole,
          };
        }),
      }),
    ]);
  }

  const record = await loadWithContext(db, mealCtx.workspaceId, ctx, rowId);
  if (!record) throw new MealServiceError('row_not_found');
  return { record, changed: true };
}

/** Remove the guests of deleted receipt rows. The caller has already authorized the row delete. */
export async function deleteGuestsForRows(db: PrismaClient, rowIds: string[]): Promise<void> {
  if (rowIds.length === 0) return;
  await db.mealGuest.deleteMany({ where: { rowId: { in: rowIds } } });
}

export async function getTaxSettings(db: PrismaClient, workspaceId: string): Promise<MealTaxSettings> {
  const row = await db.workspaceTaxSettings.findUnique({ where: { authWorkspaceId: workspaceId } });
  if (!row) return { ...DEFAULT_TAX_SETTINGS };
  return { smallBusiness: row.smallBusiness, hostAddressThresholdEur: row.hostAddressThresholdEur };
}

export interface TaxSettingsInput {
  smallBusiness: boolean;
  /** Optional: the receipt total above which the receipt must name the host. */
  hostAddressThresholdEur?: number;
}

export class TaxSettingsError extends Error {
  constructor() {
    super('invalid_threshold');
    this.name = 'TaxSettingsError';
  }
}

/** Answer (or change the answer to) the section 19 question, and optionally the host-name threshold. */
export async function saveTaxSettings(
  db: PrismaClient,
  ctx: MealContext,
  input: TaxSettingsInput,
): Promise<MealTaxSettings> {
  const threshold = input.hostAddressThresholdEur;
  if (threshold !== undefined && (!Number.isInteger(threshold) || threshold < 0 || threshold > 100_000)) {
    throw new TaxSettingsError();
  }
  const data = {
    smallBusiness: input.smallBusiness,
    ...(threshold !== undefined ? { hostAddressThresholdEur: threshold } : {}),
  };
  const row = await db.workspaceTaxSettings.upsert({
    where: { authWorkspaceId: ctx.workspaceId },
    create: { authWorkspaceId: ctx.workspaceId, authTenantId: ctx.tenantId, ...data },
    update: data,
  });
  return { smallBusiness: row.smallBusiness, hostAddressThresholdEur: row.hostAddressThresholdEur };
}

/** The host name used most recently among already loaded records, to prefill the form. */
export function lastUsedHost(records: MealRecord[]): string {
  const withHost = records
    .filter((r) => r.host.trim() && r.detailsAt)
    .sort((a, b) => (a.detailsAt! < b.detailsAt! ? 1 : -1));
  return withHost[0]?.host.trim() ?? '';
}

/**
 * The same, as one small query (for the detail panel, which has no reason to
 * load every row of the workspace just to prefill one field).
 */
export async function loadLastUsedHost(db: PrismaClient, workspaceId: string): Promise<string> {
  const ctx = await tableContext(db, workspaceId);
  if (!ctx) return '';
  const hostCol = ctx.columns.find((c) => c.name === MEAL_COLUMNS.host);
  const atCol = ctx.columns.find((c) => c.name === MEAL_COLUMNS.detailsAt);
  if (!hostCol || !atCol) return '';
  const page = await ctx.adapter.getRows(ctx.tableId, {
    filters: [
      { columnId: hostCol.id, operator: 'isNotEmpty', value: null },
      { columnId: atCol.id, operator: 'isNotEmpty', value: null },
    ],
    sorts: [{ columnId: atCol.id, direction: 'desc' }],
    limit: 1,
  });
  const value = page.items[0]?.cells[hostCol.id];
  return typeof value === 'string' ? value.trim() : '';
}
