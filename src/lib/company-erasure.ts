import 'server-only';
import { Prisma, type PrismaClient } from '@prisma/client';
import { safeTableName } from '@marlinjai/data-table-adapter-shared';
import { eraseCompanyContacts, retainUntilFrom, type ErasureCounts, type NotErased, type RegisterHasher } from './erasure';
import { stampedModels, type StampedModel } from './workspace-move';

/**
 * Everything a company erasure removes in this app, the receiving side of
 * auth-brain's signed `tenant.erased` (plan
 * docs/plans/2026-11-21-company-erasure-register.md).
 *
 * `eraseCompany` runs the steps in this order:
 *
 * 1. Nothing is touched while a row in one of the named workspaces carries the
 *    stamp of ANOTHER company (`ErasureConflictError`). Auth-brain says the
 *    workspace is the erased company's, the row says otherwise: a person looks.
 * 2. The contact data, by the existing rule (`eraseCompanyContacts`): contacts
 *    go, printed guest names go or are held.
 * 3. Bank connections and account shares end (closing the session at the bank
 *    needs the connection row, so this runs before the rows go).
 * 4. The register: every stored receipt file, then every receipts table with its
 *    rows, then every row of every table that carries the company stamp.
 * 5. A recount. Anything left that is not a held guest name fails the run
 *    (`ErasureIncompleteError`), so the delivery is answered non-2xx and sent again.
 *
 * Which rows are the company's: a row stamped with the company
 * (`auth_tenant_id`), or a row WITHOUT a stamp in a workspace auth-brain names.
 * The same rule as the workspace move.
 *
 * Repeat-safe and resumable. A stored file that is already gone counts as
 * removed, a file's references go as soon as the file is gone, and a table's
 * own row in `dt_tables` goes last, because it is the only handle a repeat has.
 *
 * Counts and reason codes only: no name, no file name, no row id leaves this module.
 */

/** What becomes of a model's rows when its company is erased. */
export type ErasureClass =
  /** Carries the company stamp: its rows are deleted by stamp. */
  | 'erased'
  /** A receipts table (`dt_tables`): deleted with its rows, files and columns, last of its group. */
  | 'table'
  /** Hangs below a receipts table and carries no stamp: deleted through the table. */
  | 'via_table'
  /** Hangs below a stamped row by a cascading foreign key. */
  | 'via_parent'
  /** Printed guest names: removed or held by the export rule (`settleGuestCopies`). */
  | 'guest_rule'
  /** A record about the company itself, keyed by the company alone: deleted. */
  | 'company_record'
  /** The erasure ledger: kept, it is the record that the erasure happened. */
  | 'ledger'
  /** Shared by every company (exchange rates, bookkeeping of the app): not company data. */
  | 'global'
  /** Belongs to a person, not to a company: ended by a person's erasure, not by this one. */
  | 'per_user';

/**
 * The models that carry no company stamp, each with the reason it is not
 * deleted by stamp. A model that is neither stamped nor listed here stops every
 * erasure (`classifyModels`), so a table added later is looked at, not skipped.
 */
export const UNSTAMPED_MODELS: Readonly<Record<string, ErasureClass>> = {
  DtColumn: 'via_table',
  DtView: 'via_table',
  DtRow: 'via_table',
  DtFile: 'via_table',
  DtRelation: 'via_table',
  DtRowSelectValue: 'via_table',
  SelectOption: 'via_table',
  SheetImportRow: 'via_parent',
  CompanyExport: 'company_record',
  ErasureEvent: 'ledger',
  FxRate: 'global',
  TaxKeyVersion: 'global',
  TaxBankSyncGuard: 'global',
  GoogleSheetsCredential: 'per_user',
};

/** Every model of the data model with what an erasure does to it. Throws on a model nobody classified. */
export function classifyModels(
  models: readonly { name: string; dbName?: string | null; fields: readonly { name: string }[] }[] = Prisma.dmmf.datamodel.models,
): Record<string, ErasureClass> {
  const stamped = new Set(stampedModels(models).map((m) => m.model));
  const out: Record<string, ErasureClass> = {};
  for (const model of models) {
    if (stamped.has(model.name)) {
      out[model.name] = model.name === 'DtTable' ? 'table' : model.name === 'MealGuest' ? 'guest_rule' : 'erased';
      continue;
    }
    const known = UNSTAMPED_MODELS[model.name];
    if (!known) throw new Error(`company erasure: model ${model.name} is not classified (erased, held or not company data)`);
    out[model.name] = known;
  }
  return out;
}

/** A row of a named workspace is stamped with another company. Nothing was erased. */
export class ErasureConflictError extends Error {
  readonly tables: string[];
  constructor(tables: string[]) {
    super('company erasure: rows of a named workspace carry the stamp of another company');
    this.name = 'ErasureConflictError';
    this.tables = tables;
  }
}

/** The file store refused to remove a file. What was removed before stays removed; a repeat goes on. */
export class StoredFileEraseError extends Error {
  constructor(cause: unknown) {
    super('company erasure: a stored file could not be removed', { cause });
    this.name = 'StoredFileEraseError';
  }
}

/** Rows of the company were still there after the run. Table names and counts only. */
export class ErasureIncompleteError extends Error {
  readonly remaining: Record<string, number>;
  constructor(remaining: Record<string, number>) {
    super('company erasure: rows of the company remain after the run');
    this.name = 'ErasureIncompleteError';
    this.remaining = remaining;
  }
}

export interface RegisterErasureCounts {
  /** Receipts tables removed (one per workspace). */
  tables: number;
  /** Rows of those tables: receipts and their groups. */
  receipts: number;
  /** Stored files removed from the file store. */
  storedFiles: number;
  /** Stored files kept because a receipt of another company still shows them. Their references here went. */
  storedFilesKept: number;
  /** Rows removed from the tables that carry the company stamp, by table. Rows that went by cascade are not counted. */
  records: Record<string, number>;
  /** Records of exports handed to the company. */
  companyExports: number;
}

export interface CompanyErasureDeps {
  /** Remove one stored file for good. Resolves when it is already gone, rejects when it could not be removed. */
  deleteStoredFile: (fileId: string) => Promise<void>;
  endBankConnections: (tenantId: string, workspaceIds: readonly string[]) => Promise<number>;
  endAccountShares: (tenantId: string, workspaceIds: readonly string[]) => Promise<{ shares: number; links: number; records: number }>;
  now?: Date;
  hasher?: RegisterHasher;
}

type Db = PrismaClient | Prisma.TransactionClient;

interface CountDelegate {
  count(args: { where: Record<string, unknown> }): Promise<number>;
  deleteMany(args: { where: Record<string, unknown> }): Promise<{ count: number }>;
}

function delegateOf(db: Db, model: StampedModel): CountDelegate {
  const delegate = (db as unknown as Record<string, CountDelegate | undefined>)[model.delegate];
  if (!delegate) throw new Error(`company erasure: the Prisma client has no model ${model.model}`);
  return delegate;
}

/** The company's rows of one stamped table: its stamp, or no stamp in a workspace auth-brain names. */
export function companyRowsWhere(model: Pick<StampedModel, 'workspaceField'>, tenantId: string, workspaceIds: readonly string[]): Record<string, unknown> {
  return {
    OR: [
      { authTenantId: tenantId },
      ...(workspaceIds.length > 0 ? [{ [model.workspaceField]: { in: [...workspaceIds] }, authTenantId: null }] : []),
    ],
  };
}

/** Rows of a named workspace that another company's stamp claims. */
function foreignRowsWhere(model: StampedModel, tenantId: string, workspaceIds: readonly string[]): Record<string, unknown> {
  return { [model.workspaceField]: { in: [...workspaceIds] }, AND: [{ authTenantId: { not: null } }, { authTenantId: { not: tenantId } }] };
}

/** Throws `ErasureConflictError` while a named workspace holds a row stamped with another company. */
export async function assertNoForeignRows(db: Db, tenantId: string, workspaceIds: readonly string[]): Promise<void> {
  if (workspaceIds.length === 0) return;
  const tables: string[] = [];
  for (const model of stampedModels()) {
    if ((await delegateOf(db, model).count({ where: foreignRowsWhere(model, tenantId, workspaceIds) })) > 0) tables.push(model.table);
  }
  if (tables.length > 0) throw new ErasureConflictError(tables);
}

/** Lists longer than this are split, so no statement carries more parameters than Postgres takes. */
const ID_CHUNK = 5000;
/** Stored files removed at the same time. */
const FILE_DELETES_AT_ONCE = 4;

function chunks<T>(items: readonly T[], size = ID_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * The ids of every row of one receipts table, from both layouts: the table's own
 * physical table (`tbl_<id>`) and the older shared `dt_rows`. A read that fails
 * throws: an erasure never goes on with a list it could not read.
 */
async function rowIdsOfTable(db: Db, tableId: string): Promise<string[]> {
  const name = safeTableName(tableId);
  const [{ present }] = await db.$queryRaw<Array<{ present: boolean }>>`SELECT to_regclass(${`public.${name}`}::text) IS NOT NULL AS present`;
  const physical = present ? await db.$queryRawUnsafe<Array<{ id: string }>>(`SELECT id FROM ${name}`) : [];
  const legacy = await db.dtRow.findMany({ where: { tableId }, select: { id: true } });
  return [...new Set([...physical.map((r) => r.id), ...legacy.map((r) => r.id)])];
}

/**
 * Remove the company's receipts tables with their rows and stored files, every
 * row that carries its stamp, and the records of its exports. Printed guest
 * names (`meal_guests`) are left to the export rule, which ran before.
 */
export async function eraseCompanyRegister(
  db: PrismaClient,
  tenantId: string,
  workspaceIds: readonly string[],
  deps: Pick<CompanyErasureDeps, 'deleteStoredFile'>,
): Promise<RegisterErasureCounts> {
  const classes = classifyModels();
  const models = stampedModels();
  const tableModel = models.find((m) => m.model === 'DtTable');
  if (!tableModel) throw new Error('company erasure: the data model has no receipts table model');

  // 1. The receipts tables and every row id below them.
  const tables = await db.dtTable.findMany({ where: companyRowsWhere(tableModel, tenantId, workspaceIds), select: { id: true }, orderBy: { id: 'asc' } });
  const rowIdsByTable = new Map<string, string[]>();
  for (const table of tables) rowIdsByTable.set(table.id, await rowIdsOfTable(db, table.id));
  const erasedRows = new Set([...rowIdsByTable.values()].flat());

  // 2. The stored files, before any row goes: a file whose row is gone could never be found again.
  //    A file a receipt outside the erased set still shows belongs to that receipt too and is kept.
  const refs: Array<{ id: string; fileId: string }> = [];
  for (const part of chunks([...erasedRows])) {
    refs.push(...(await db.dtFile.findMany({ where: { rowId: { in: part } }, select: { id: true, fileId: true } })));
  }
  const refIdsByFile = new Map<string, string[]>();
  for (const ref of refs) refIdsByFile.set(ref.fileId, [...(refIdsByFile.get(ref.fileId) ?? []), ref.id]);
  const fileIds = [...refIdsByFile.keys()].sort();
  const shared = new Set<string>();
  for (const part of chunks(fileIds)) {
    for (const ref of await db.dtFile.findMany({ where: { fileId: { in: part } }, select: { fileId: true, rowId: true } })) {
      if (!erasedRows.has(ref.rowId)) shared.add(ref.fileId);
    }
  }
  const removable = fileIds.filter((id) => !shared.has(id));
  let storedFiles = 0;
  for (const batch of chunks(removable, FILE_DELETES_AT_ONCE)) {
    const results = await Promise.allSettled(
      batch.map(async (fileId) => {
        await deps.deleteStoredFile(fileId);
        // The file is gone for good, so its references go at once: a repeat starts after it.
        await db.dtFile.deleteMany({ where: { id: { in: refIdsByFile.get(fileId) ?? [] } } });
      }),
    );
    storedFiles += results.filter((r) => r.status === 'fulfilled').length;
    const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failed) throw new StoredFileEraseError(failed.reason);
  }

  // 3. Each table with what hangs below it, in one transaction per table. Its own row goes last.
  let receipts = 0;
  for (const table of tables) {
    const rowIds = rowIdsByTable.get(table.id) ?? [];
    await db.$transaction(
      async (tx) => {
        for (const part of chunks(rowIds)) {
          await tx.dtFile.deleteMany({ where: { rowId: { in: part } } });
          await tx.dtRelation.deleteMany({ where: { OR: [{ sourceRowId: { in: part } }, { targetRowId: { in: part } }] } });
          await tx.dtRowSelectValue.deleteMany({ where: { rowId: { in: part } } });
        }
        await tx.$executeRawUnsafe(`DROP TABLE IF EXISTS ${safeTableName(table.id)}`);
        await tx.dtRow.deleteMany({ where: { tableId: table.id } });
        const columns = await tx.dtColumn.findMany({ where: { tableId: table.id }, select: { id: true } });
        await tx.selectOption.deleteMany({ where: { columnId: { in: columns.map((c) => c.id) } } });
        await tx.dtColumn.deleteMany({ where: { tableId: table.id } });
        await tx.dtView.deleteMany({ where: { tableId: table.id } });
        await tx.dtTable.delete({ where: { id: table.id } });
      },
      { maxWait: 10_000, timeout: 60_000 },
    );
    receipts += rowIds.length;
  }

  // 4. Every other row that carries the company stamp, in one transaction. Counted first, because
  //    a parent that goes takes its children along and they would then count as nothing.
  const records: Record<string, number> = {};
  const byStamp = models.filter((m) => classes[m.model] === 'erased');
  await db.$transaction(
    async (tx) => {
      for (const model of byStamp) {
        const n = await delegateOf(tx, model).count({ where: companyRowsWhere(model, tenantId, workspaceIds) });
        if (n > 0) records[model.table] = n;
      }
      for (const model of byStamp) await delegateOf(tx, model).deleteMany({ where: companyRowsWhere(model, tenantId, workspaceIds) });
    },
    { maxWait: 10_000, timeout: 60_000 },
  );

  // 5. The records of exports handed over. Last: the export rule for guest names read them before.
  const companyExports = (await db.companyExport.deleteMany({ where: { authTenantId: tenantId } })).count;

  return { tables: tables.length, receipts, storedFiles, storedFilesKept: shared.size, records, companyExports };
}

/**
 * What the company still has here, by table. Held guest names are counted
 * apart (`heldGuestCopies`): they are the one thing an erasure may leave.
 */
export async function countCompanyRemainder(
  db: Db,
  tenantId: string,
  workspaceIds: readonly string[],
): Promise<{ remaining: Record<string, number>; heldGuestCopies: number }> {
  const classes = classifyModels();
  const remaining: Record<string, number> = {};
  let heldGuestCopies = 0;
  for (const model of stampedModels()) {
    const where = companyRowsWhere(model, tenantId, workspaceIds);
    if (classes[model.model] === 'guest_rule') {
      heldGuestCopies = await db.mealGuest.count({ where: { AND: [where, { contactId: null, retainUntil: { not: null } }] } });
      const other = await db.mealGuest.count({ where: { AND: [where, { NOT: { contactId: null, retainUntil: { not: null } } }] } });
      if (other > 0) remaining[model.table] = other;
      continue;
    }
    const n = await delegateOf(db, model).count({ where });
    if (n > 0) remaining[model.table] = n;
  }
  const exports = await db.companyExport.count({ where: { authTenantId: tenantId } });
  if (exports > 0) remaining.company_exports = exports;
  return { remaining, heldGuestCopies };
}

/**
 * What an erasure does not remove, said in every answer so that an
 * acknowledgement is never read as "nothing of this company exists any more".
 * Codes and numbers only.
 */
export function notErasedAfter(input: { heldGuestCopies: number; retainUntil: Date | null; storedFilesKept: number }): NotErased[] {
  const out: NotErased[] = [];
  if (input.heldGuestCopies > 0) {
    out.push({ what: 'guest_copies_held', count: input.heldGuestCopies, ...(input.retainUntil ? { until: input.retainUntil.toISOString().slice(0, 10) } : {}) });
  }
  if (input.storedFilesKept > 0) out.push({ what: 'stored_files_shown_by_another_company', count: input.storedFilesKept });
  // Technical retention, not a legal one: the dumps of the database rotate out by themselves.
  out.push({ what: 'database_backups', days: BACKUP_RETENTION_DAYS });
  // An upload that never became a receipt has no row and so no company: this app cannot find it.
  out.push({ what: 'uploads_never_attached_to_a_receipt' });
  return out;
}

/**
 * How long a dump of the database is kept at most (docs/plans/2026-10-09-production-backups.md:
 * seven days on the server, thirty days in the two copies off the server).
 */
export const BACKUP_RETENTION_DAYS = 30;

/** The whole erasure of one company. See the module comment for the order and the rules. */
export async function eraseCompany(db: PrismaClient, tenantId: string, workspaceIds: readonly string[], deps: CompanyErasureDeps): Promise<ErasureCounts> {
  const now = deps.now ?? new Date();
  classifyModels();
  await assertNoForeignRows(db, tenantId, workspaceIds);

  const contacts = await eraseCompanyContacts(db, tenantId, workspaceIds, now, deps.hasher);
  // A printed name that was never linked to a contact got no date from the rule above. Once its meal is
  // gone it would stay for ever, so a held name always carries the date it may go. Never moves a date.
  const tableOfGuests = { workspaceField: 'authWorkspaceId' as const };
  await db.mealGuest.updateMany({
    where: { AND: [companyRowsWhere(tableOfGuests, tenantId, workspaceIds), { retainUntil: null }] },
    data: { contactId: null, retainUntil: retainUntilFrom(now) },
  });

  const bankConnections = await deps.endBankConnections(tenantId, workspaceIds);
  const shares = await deps.endAccountShares(tenantId, workspaceIds);
  const register = await eraseCompanyRegister(db, tenantId, workspaceIds, deps);

  const { remaining, heldGuestCopies } = await countCompanyRemainder(db, tenantId, workspaceIds);
  if (Object.keys(remaining).length > 0) throw new ErasureIncompleteError(remaining);

  const latestHold =
    heldGuestCopies > 0
      ? await db.mealGuest.findFirst({
          where: { AND: [companyRowsWhere(tableOfGuests, tenantId, workspaceIds), { contactId: null, retainUntil: { not: null } }] },
          orderBy: { retainUntil: 'desc' },
          select: { retainUntil: true },
        })
      : null;

  return {
    ...contacts,
    guestCopiesHeld: heldGuestCopies,
    bankConnections,
    accountShares: shares.shares,
    crossCompanyLinks: shares.links,
    crossCompanyRecords: shares.records,
    register,
    notErased: notErasedAfter({ heldGuestCopies, retainUntil: latestHold?.retainUntil ?? null, storedFilesKept: register.storedFilesKept }),
  };
}
