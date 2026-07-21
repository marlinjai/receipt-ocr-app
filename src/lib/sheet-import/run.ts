import 'server-only';
import { PrismaAdapter } from '@marlinjai/data-table-adapter-prisma';
import { prisma } from '@/lib/prisma';
import { getFxRate } from '@/lib/fx-rates';
import { getAccessTokenForUser } from './google-credentials';
import { parseSpreadsheetId, readSheetValues, gridToRows } from './sheets-client';
import { mapRow, computeDedupKey, type ColumnMapping, type ImportableField } from './normalize';
import { buildCells, type ColumnLike } from './build-cells';

const TABLE_NAME = 'Receipts';

export class SheetImportError extends Error {
  readonly code: string;
  constructor(code: string, message?: string) {
    super(message ?? code);
    this.code = code;
    this.name = 'SheetImportError';
  }
}

export interface RunImportInput {
  authWorkspaceId: string;
  authUserId: string;
  spreadsheet: string; // URL or id
  tab: string;
  headerRow: number;
  columnMapping: ColumnMapping;
  dedupKeyFields: ImportableField[];
}

export interface RunImportResult {
  imported: number;
  updated: number;
  skipped: number;
  total: number;
}

/**
 * Read a sheet and upsert its rows into the active workspace's Receipts table.
 *
 * Idempotent: each row's stable dedup key (over `dedupKeyFields`) is looked up in
 * the per-config `sheet_import_rows` ledger. Known keys update the existing
 * dt_row; new keys create one and record it. Rows that duplicate an earlier row
 * *within the same sheet* are skipped. The config (spreadsheet/tab + mapping +
 * dedup fields) is persisted so a re-run reuses it.
 */
export async function runSheetImport(input: RunImportInput): Promise<RunImportResult> {
  const spreadsheetId = parseSpreadsheetId(input.spreadsheet);
  if (!spreadsheetId) throw new SheetImportError('invalid_spreadsheet');
  if (!input.tab) throw new SheetImportError('no_tab');
  if (input.dedupKeyFields.length === 0) throw new SheetImportError('no_dedup_fields');

  const accessToken = await getAccessTokenForUser(input.authUserId);
  if (!accessToken) throw new SheetImportError('not_connected');

  const values = await readSheetValues(accessToken, spreadsheetId, input.tab);
  const { rows } = gridToRows(values, input.headerRow);

  const adapter = new PrismaAdapter({ prisma });
  const tables = await adapter.listTables(input.authWorkspaceId);
  const table = tables.find((t) => t.name === TABLE_NAME);
  if (!table) throw new SheetImportError('table_not_initialized');
  const columns = (await adapter.getColumns(table.id)) as ColumnLike[];

  // Resolve select-option ids once: colName -> (optionName -> optionId).
  const optionIdByName: Record<string, Record<string, string>> = {};
  let statusOptionId: string | null = null;
  for (const col of columns) {
    if (col.type !== 'select') continue;
    const opts = await adapter.getSelectOptions(col.id);
    optionIdByName[col.name] = Object.fromEntries(opts.map((o) => [o.name, o.id]));
    if (col.name === 'Status') {
      statusOptionId = optionIdByName.Status['Imported'] ?? optionIdByName.Status['Pending'] ?? null;
    }
  }

  const config = await prisma.sheetImportConfig.upsert({
    where: {
      authWorkspaceId_spreadsheetId_sheetName: {
        authWorkspaceId: input.authWorkspaceId,
        spreadsheetId,
        sheetName: input.tab,
      },
    },
    create: {
      authWorkspaceId: input.authWorkspaceId,
      spreadsheetId,
      sheetName: input.tab,
      headerRow: input.headerRow,
      columnMapping: input.columnMapping,
      dedupKeyFields: input.dedupKeyFields,
      createdByUserId: input.authUserId,
      lastRunAt: new Date(),
    },
    update: {
      headerRow: input.headerRow,
      columnMapping: input.columnMapping,
      dedupKeyFields: input.dedupKeyFields,
      lastRunAt: new Date(),
    },
  });

  const ledgerRows = await prisma.sheetImportRow.findMany({
    where: { configId: config.id },
    select: { dedupKey: true, dtRowId: true },
  });
  const ledger = new Map(ledgerRows.map((r) => [r.dedupKey, r.dtRowId]));

  let imported = 0;
  let updated = 0;
  let skipped = 0;
  const seen = new Set<string>();

  for (const raw of rows) {
    const mapped = mapRow(raw, input.columnMapping);
    const key = computeDedupKey(mapped, input.dedupKeyFields);
    if (seen.has(key)) {
      skipped++; // duplicate within this sheet
      continue;
    }
    seen.add(key);

    const currency = typeof mapped.Currency === 'string' && mapped.Currency ? mapped.Currency : 'EUR';
    const date = typeof mapped.Date === 'string' ? mapped.Date : null;
    const fxRate = currency === 'EUR' ? 1 : await getFxRate(currency, date);
    const cells = buildCells(mapped, columns, optionIdByName, { fxRate, statusOptionId });

    const existingRowId = ledger.get(key);
    if (existingRowId) {
      await adapter.updateRow(existingRowId, cells);
      updated++;
    } else {
      const row = await adapter.createRow({ tableId: table.id, cells });
      await prisma.sheetImportRow.create({ data: { configId: config.id, dedupKey: key, dtRowId: row.id } });
      imported++;
    }
  }

  return { imported, updated, skipped, total: rows.length };
}
