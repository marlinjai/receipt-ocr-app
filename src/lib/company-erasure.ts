import 'server-only';
import { Prisma, type PrismaClient } from '@prisma/client';
import { safeTableName } from '@marlinjai/data-table-adapter-shared';
import { companyContacts } from './contacts/db';
import { eraseCompanyContacts, type ErasureCounts, type NotErased, type RegisterHasher } from './erasure';
import { stampedModels, type StampedModel } from './workspace-move';

/**
 * Everything a company erasure removes in this app, the receiving side of
 * auth-brain's signed `tenant.erased` (plan
 * docs/plans/2026-11-21-company-erasure-register.md).
 *
 * `eraseCompany` runs the steps in this order. Only one erasure works at a time
 * in the whole app: the caller holds a lease for the run (erasure-ledger.ts) and
 * hands in `checkpoint`, which is called between the steps and stops the run
 * when the lease is gone:
 *
 * 1. Nothing is touched while the stamps and the delivery disagree
 *    (`ErasureConflictError`): a row in a named workspace carries the stamp of
 *    ANOTHER company, or a row with THIS company's stamp lies in a workspace the
 *    delivery does not name (also when it names none). Either way auth-brain and the rows say different
 *    things about whose data it is, and a person looks.
 * 2. The contact data, by the existing rule (`eraseCompanyContacts`): contacts
 *    go, printed guest names go or are held.
 * 3. Bank connections and account shares end (closing the session at the bank
 *    needs the connection row, so this runs before the rows go).
 * 4. The register: every stored receipt file, then every receipts table with its
 *    rows, then every row of every table that carries the company stamp.
 * 5. A recount, also of the tables below a receipts table and of the contacts
 *    database. Anything left that is not a held guest name fails the run
 *    (`ErasureIncompleteError`), so the delivery is answered non-2xx and sent again.
 *
 * Which rows are the company's: a row stamped with the company
 * (`auth_tenant_id`), or a row WITHOUT a stamp in a workspace auth-brain names.
 * The same rule as the workspace move.
 *
 * Repeat-safe and resumable. A stored file that is already gone is not an
 * error, a file's references go as soon as the file is gone, and a table's own
 * row in `dt_tables` goes last, because it is the only handle a repeat has.
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

/**
 * The stamps and the delivery disagree about whose rows these are. Nothing was erased.
 * - `rows_of_another_company`: a named workspace holds rows stamped with another company.
 * - `rows_outside_named_workspaces`: rows stamped with the erased company lie in a
 *   workspace the delivery does not name (the workspace was moved to another company
 *   without its rows being restamped, or it was deleted before the company was).
 */
export class ErasureConflictError extends Error {
  readonly kind: 'rows_of_another_company' | 'rows_outside_named_workspaces';
  readonly tables: string[];
  /** The workspaces the offending rows lie in (ids only, at most `CONFLICT_WORKSPACES_NAMED`). */
  readonly workspaces: string[];
  constructor(kind: ErasureConflictError['kind'], tables: string[], workspaces: string[] = []) {
    super(`company erasure: ${kind}`);
    this.name = 'ErasureConflictError';
    this.kind = kind;
    this.tables = tables;
    this.workspaces = workspaces;
  }
}

/** The file store refused to remove a file. What was removed before stays removed; a repeat goes on. */
export class StoredFileEraseError extends Error {
  constructor(cause: unknown) {
    super('company erasure: a stored file could not be removed', { cause });
    this.name = 'StoredFileEraseError';
  }
}

/**
 * A file was attached to a receipt of the company after its files had been
 * removed. The table is left as it is; the next run removes that file too.
 */
export class ErasureChangedError extends Error {
  constructor() {
    super('company erasure: a file was attached while the run went on');
    this.name = 'ErasureChangedError';
  }
}

/**
 * A table could not be locked within `TABLE_LOCK_WAIT_MS`: another writer held it or the file
 * references. Nothing of that table was touched; the next run tries again.
 */
export class ErasureTablesBusyError extends Error {
  constructor(cause: unknown) {
    super('company erasure: a table stayed locked by another writer', { cause });
    this.name = 'ErasureTablesBusyError';
  }
}

/** One file reference left below an erased receipt: its own id and the id of the stored file it names. */
export interface LeftFileReference {
  referenceId: string;
  fileId: string;
}

/** Something of the company was still there after the run. Table names, counts and ids only. */
export class ErasureIncompleteError extends Error {
  readonly remaining: Record<string, number>;
  /**
   * File references left below receipts this run removed (at most `LEFT_REFERENCES_NAMED`). The next
   * run cannot find them, because the rows they name are gone, so they are named here for a person.
   */
  readonly fileReferences: LeftFileReference[];
  constructor(remaining: Record<string, number>, fileReferences: LeftFileReference[] = []) {
    super('company erasure: rows of the company remain after the run');
    this.name = 'ErasureIncompleteError';
    this.remaining = remaining;
    this.fileReferences = fileReferences;
  }
}

export interface RegisterErasureCounts {
  /** Receipts tables removed (one per workspace). */
  tables: number;
  /** Rows of those tables: receipts and their groups. */
  receipts: number;
  /** Stored files this run removed from the file store. */
  storedFiles: number;
  /** Stored files the file store no longer had (an earlier run removed them and stopped before their reference went). */
  storedFilesAlreadyGone: number;
  /** Stored files kept because a receipt outside this erasure still shows them. Their references here went. */
  storedFilesKept: number;
  /**
   * Rows removed from the tables that carry the company stamp, by table. A stamped row that went
   * with its parent is counted under its own table (every table is counted before anything is
   * deleted). Rows of a table WITHOUT a stamp that went by a foreign key (`sheet_import_rows`) are not counted.
   */
  records: Record<string, number>;
  /** Records of exports handed to the company. */
  companyExports: number;
}

export interface CompanyErasureDeps {
  /**
   * Remove one stored file for good. Resolves when it is already gone (saying so
   * with `already_gone` where it can tell), rejects when it could not be removed.
   */
  deleteStoredFile: (fileId: string) => Promise<'removed' | 'already_gone' | void>;
  endBankConnections: (tenantId: string, workspaceIds: readonly string[]) => Promise<{ connections: number; sessionsLeftOpen: number }>;
  endAccountShares: (tenantId: string, workspaceIds: readonly string[]) => Promise<{ shares: number; links: number; records: number }>;
  /**
   * Called between the steps of a run. Rejects when the run may not go on (its lease is gone);
   * the run then stops there, and what it removed so far is reported as `partial`.
   */
  checkpoint?: () => Promise<void>;
  /** How long the removal of one table waits for a lock another writer holds. Injected in tests. */
  tableLockWaitMs?: number;
  /** How many contacts the company still has in the shared contacts database. Injected in tests. */
  countContacts?: (tenantId: string) => Promise<number>;
  now?: Date;
  hasher?: RegisterHasher;
}

type Db = PrismaClient | Prisma.TransactionClient;

interface CountDelegate {
  count(args: { where: Record<string, unknown> }): Promise<number>;
  findMany(args: { where: Record<string, unknown>; select: Record<string, true>; distinct: string[]; take: number }): Promise<Array<Record<string, string>>>;
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

/**
 * Stops the erasure while the stamps and the delivery disagree.
 *
 * Both directions matter. A named workspace with another company's stamp: the
 * delivery would take that company's rows. The company's stamp in a workspace
 * the delivery does not name: auth-brain says that workspace is not (or no
 * longer) the company's, for example after it was moved to another company and
 * the restamp here did not happen. Deleting by the stale stamp would then
 * destroy the new owner's receipts and files.
 *
 * A delivery that names NO workspace is held to the same rule: then every row
 * with the company's stamp lies outside the named workspaces, and the run stops.
 * Erasing by stamp alone would be the one case with no second opinion, and it is
 * reachable: a company whose only workspace was moved away without a restamp and
 * that is then deleted names no workspace, and its stale stamp sits on the new
 * owner's receipts. A company that truly has rows here and no workspace left in
 * auth-brain is erased by a delivery sent by hand that names its workspaces
 * (docs/operations/company-erasure.md). A company with no rows here passes.
 */
export async function assertStampsMatchDelivery(db: Db, tenantId: string, workspaceIds: readonly string[]): Promise<void> {
  const ids = [...workspaceIds];
  const foreign = { tables: [] as string[], workspaces: new Set<string>() };
  const outside = { tables: [] as string[], workspaces: new Set<string>() };
  for (const model of stampedModels()) {
    const delegate = delegateOf(db, model);
    const field = model.workspaceField;
    /** The workspaces the rows matching `where` lie in, for the person who has to look. */
    const note = async (into: typeof foreign, where: Record<string, unknown>) => {
      const rows = await delegate.findMany({ where, select: { [field]: true }, distinct: [field], take: CONFLICT_WORKSPACES_NAMED });
      if (rows.length === 0) return;
      into.tables.push(model.table);
      for (const row of rows) into.workspaces.add(row[field]);
    };
    await note(foreign, { [field]: { in: ids }, AND: [{ authTenantId: { not: null } }, { authTenantId: { not: tenantId } }] });
    await note(outside, { authTenantId: tenantId, [field]: { notIn: ids } });
  }
  const named = (set: Set<string>) => [...set].sort().slice(0, CONFLICT_WORKSPACES_NAMED);
  if (foreign.tables.length > 0) throw new ErasureConflictError('rows_of_another_company', foreign.tables, named(foreign.workspaces));
  if (outside.tables.length > 0) throw new ErasureConflictError('rows_outside_named_workspaces', outside.tables, named(outside.workspaces));
}

/** The most workspace ids a conflict names. Enough to act on; a conflict over more is a matter for a query. */
const CONFLICT_WORKSPACES_NAMED = 50;

/** Lists longer than this are split, so no statement carries more parameters than Postgres takes. */
const ID_CHUNK = 5000;
/**
 * How long the removal of one table waits for a lock. Writers of every company attach and detach
 * files through the same file reference table, so the run must neither stall them for long nor
 * queue behind one of them without end. Past this it stops as retryable (`ErasureTablesBusyError`).
 */
const TABLE_LOCK_WAIT_MS = 5000;
/** The most left file references an incomplete run names. */
const LEFT_REFERENCES_NAMED = 50;
/** Stored files removed at the same time. */
const FILE_DELETES_AT_ONCE = 4;
function chunks<T>(items: readonly T[], size = ID_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function physicalTableExists(db: Db, tableId: string): Promise<boolean> {
  const [{ present }] = await db.$queryRaw<Array<{ present: boolean }>>`SELECT to_regclass(${`public.${safeTableName(tableId)}`}::text) IS NOT NULL AS present`;
  return present;
}

/**
 * The ids of every row of one receipts table, from both layouts: the table's own
 * physical table (`tbl_<id>`) and the older shared `dt_rows`. A read that fails
 * throws: an erasure never goes on with a list it could not read. A physical
 * table that does not exist (never created, or dropped already) has no rows.
 */
async function rowIdsOfTable(db: Db, tableId: string): Promise<string[]> {
  const physical = (await physicalTableExists(db, tableId)) ? await db.$queryRawUnsafe<Array<{ id: string }>>(`SELECT id FROM ${safeTableName(tableId)}`) : [];
  const legacy = await db.dtRow.findMany({ where: { tableId }, select: { id: true } });
  return [...new Set([...physical.map((r) => r.id), ...legacy.map((r) => r.id)])];
}

/**
 * Of the given row ids, the ones that are rows of a receipts table OUTSIDE this
 * erasure (another company's table, or one in a workspace the delivery did not
 * name). A row id that is in no table at all is not among them: its receipt is gone.
 */
async function rowsLivingElsewhere(db: Db, rowIds: readonly string[], erasedTableIds: readonly string[]): Promise<Set<string>> {
  const living = new Set<string>();
  if (rowIds.length === 0) return living;
  const others = await db.dtTable.findMany({ where: { id: { notIn: [...erasedTableIds] } }, select: { id: true } });
  for (const part of chunks(rowIds)) {
    for (const row of await db.dtRow.findMany({ where: { id: { in: part }, tableId: { notIn: [...erasedTableIds] } }, select: { id: true } })) living.add(row.id);
    for (const table of others) {
      if (!(await physicalTableExists(db, table.id))) continue;
      const hits = await db.$queryRawUnsafe<Array<{ id: string }>>(`SELECT id FROM ${safeTableName(table.id)} WHERE id = ANY($1::text[])`, part);
      for (const hit of hits) living.add(hit.id);
    }
  }
  return living;
}

/** Postgres gave up waiting for a lock (`lock_timeout`, error 55P03). */
function isLockTimeout(e: unknown): boolean {
  const error = e as { code?: string; meta?: { code?: string }; message?: string } | undefined;
  return error?.meta?.code === '55P03' || error?.code === '55P03' || /55P03|lock timeout/i.test(error?.message ?? '');
}

/** What `eraseCompanyRegister` removed, by id, so the recount can look for what should be gone. Never leaves this module. */
export interface ErasedHandles {
  tableIds: string[];
  rowIds: string[];
}

function emptyRegisterCounts(): RegisterErasureCounts {
  return { tables: 0, receipts: 0, storedFiles: 0, storedFilesAlreadyGone: 0, storedFilesKept: 0, records: {}, companyExports: 0 };
}

/**
 * Remove the stored files the given rows show, and the references to them.
 *
 * A file a living receipt outside this erasure still shows is that receipt's
 * file too: it is kept and counted, and only the erased rows' references to it
 * go later, with their table. A reference whose row is in no table any more is
 * nobody's: it does not keep the file, and it goes with it.
 *
 * Answers the ids of the files kept, so the caller knows which references may
 * still be there. A file store that refuses rejects with `StoredFileEraseError`;
 * what was removed before stays removed.
 */
async function removeStoredFilesOfRows(
  db: PrismaClient,
  rowIds: ReadonlySet<string>,
  erasedTableIds: readonly string[],
  deps: Pick<CompanyErasureDeps, 'deleteStoredFile' | 'checkpoint'>,
  counts: RegisterErasureCounts,
): Promise<Set<string>> {
  const ownRefs: Array<{ fileId: string }> = [];
  for (const part of chunks([...rowIds])) ownRefs.push(...(await db.dtFile.findMany({ where: { rowId: { in: part } }, select: { fileId: true } })));
  const fileIds = [...new Set(ownRefs.map((r) => r.fileId))].sort();
  // Every reference to those files, also from rows outside this erasure.
  const allRefs: Array<{ id: string; fileId: string; rowId: string }> = [];
  for (const part of chunks(fileIds)) allRefs.push(...(await db.dtFile.findMany({ where: { fileId: { in: part } }, select: { id: true, fileId: true, rowId: true } })));
  const outsideRowIds = [...new Set(allRefs.filter((r) => !rowIds.has(r.rowId)).map((r) => r.rowId))];
  const living = await rowsLivingElsewhere(db, outsideRowIds, erasedTableIds);
  const keptFiles = new Set(allRefs.filter((r) => living.has(r.rowId)).map((r) => r.fileId));
  const refIdsByFile = new Map<string, string[]>();
  for (const ref of allRefs) refIdsByFile.set(ref.fileId, [...(refIdsByFile.get(ref.fileId) ?? []), ref.id]);

  const removable = fileIds.filter((id) => !keptFiles.has(id));
  for (const batch of chunks(removable, FILE_DELETES_AT_ONCE)) {
    await deps.checkpoint?.();
    const results = await Promise.allSettled(
      batch.map(async (fileId) => {
        const outcome = await deps.deleteStoredFile(fileId);
        // The file is gone for good, so its references go at once: a repeat starts after it.
        await db.dtFile.deleteMany({ where: { id: { in: refIdsByFile.get(fileId) ?? [] } } });
        return outcome;
      }),
    );
    for (const result of results) {
      if (result.status !== 'fulfilled') continue;
      if (result.value === 'already_gone') counts.storedFilesAlreadyGone++;
      else counts.storedFiles++;
    }
    const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failed) throw new StoredFileEraseError(failed.reason);
  }
  return keptFiles;
}

/**
 * Remove the company's receipts tables with their rows and stored files, every
 * row that carries its stamp, and the records of its exports. Printed guest
 * names (`meal_guests`) are left to the export rule, which ran before.
 *
 * `counts` is filled in as the run goes, so a run that stops can still say what
 * it had removed.
 */
export async function eraseCompanyRegister(
  db: PrismaClient,
  tenantId: string,
  workspaceIds: readonly string[],
  deps: Pick<CompanyErasureDeps, 'deleteStoredFile' | 'checkpoint' | 'tableLockWaitMs'>,
  counts: RegisterErasureCounts = emptyRegisterCounts(),
): Promise<{ counts: RegisterErasureCounts; erased: ErasedHandles }> {
  const classes = classifyModels();
  const models = stampedModels();
  const tableModel = models.find((m) => m.model === 'DtTable');
  if (!tableModel) throw new Error('company erasure: the data model has no receipts table model');

  // 1. The receipts tables and every row id below them.
  const tables = await db.dtTable.findMany({ where: companyRowsWhere(tableModel, tenantId, workspaceIds), select: { id: true }, orderBy: { id: 'asc' } });
  const tableIds = tables.map((t) => t.id);
  const rowIdsByTable = new Map<string, string[]>();
  for (const table of tables) rowIdsByTable.set(table.id, await rowIdsOfTable(db, table.id));
  const erasedRows = new Set([...rowIdsByTable.values()].flat());

  // 2. The stored files, before any row goes: a file whose row is gone could never be found again.
  const keptFiles = await removeStoredFilesOfRows(db, erasedRows, tableIds, deps, counts);

  // 3. Each table with what hangs below it, in one transaction per table. Its own row goes last.
  for (const table of tables) {
    await deps.checkpoint?.();
    const listed = rowIdsByTable.get(table.id) ?? [];
    const removedRows = await db
      .$transaction(
      async (tx) => {
        // Every lock this transaction asks for gives up after a few seconds instead of waiting: the
        // file references are shared by all companies, and a run that queued behind a slow writer
        // would make every later writer queue behind it.
        await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = ${Math.max(1, Math.floor(deps.tableLockWaitMs ?? TABLE_LOCK_WAIT_MS))}`);
        // The rows are read again under a lock that keeps every writer out until the table is gone:
        // a receipt written since the first listing is removed like the others, not left behind.
        const present = await physicalTableExists(tx, table.id);
        if (present) await tx.$executeRawUnsafe(`LOCK TABLE ${safeTableName(table.id)} IN ACCESS EXCLUSIVE MODE`);
        // File references live in their own table, which the lock above does not cover. Writers to it
        // wait until this transaction ends (readers do not), so no reference can appear between the
        // check below and the delete after it.
        await tx.$executeRawUnsafe('LOCK TABLE dt_files IN SHARE ROW EXCLUSIVE MODE');
        const rowIds = [...new Set([...listed, ...(await rowIdsOfTable(tx, table.id))])];
        // Its files were handled above. A reference that is here now and names a file not kept on purpose
        // names a stored file nobody removed: stop, the next run removes it. Nothing of this table is touched.
        for (const part of chunks(rowIds)) {
          const unexpected = await tx.dtFile.count({ where: { rowId: { in: part }, fileId: { notIn: [...keptFiles] } } });
          if (unexpected > 0) throw new ErasureChangedError();
        }
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
        // deleteMany, not delete: the row may be gone already and that is not an error here.
        await tx.dtTable.deleteMany({ where: { id: table.id } });
        return rowIds;
      },
      { maxWait: 10_000, timeout: 60_000 },
      )
      .catch((e) => {
        if (isLockTimeout(e)) throw new ErasureTablesBusyError(e);
        throw e;
      });
    for (const id of removedRows) erasedRows.add(id);
    counts.tables++;
    counts.receipts += removedRows.length;
  }

  // 3b. A writer that waited for a table's transaction lands its file reference after the table is gone:
  //     a reference to a row that no longer exists, naming a stored file nobody removed. Remove those
  //     files and references now, so nothing of the erased receipts is left for the recount to trip over.
  await deps.checkpoint?.();
  const keptLate = await removeStoredFilesOfRows(db, erasedRows, tableIds, deps, counts);
  for (const part of chunks([...erasedRows])) await db.dtFile.deleteMany({ where: { rowId: { in: part } } });
  counts.storedFilesKept = new Set([...keptFiles, ...keptLate]).size;

  // 4. Every other row that carries the company stamp, in one transaction. Each table is counted
  //    before anything is deleted, so a row that goes with its parent is counted under its own table.
  await deps.checkpoint?.();
  const byStamp = models.filter((m) => classes[m.model] === 'erased');
  const records: Record<string, number> = {};
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
  counts.records = records;

  // 5. The records of exports handed over. Last: the export rule for guest names read them before.
  counts.companyExports = (await db.companyExport.deleteMany({ where: { authTenantId: tenantId } })).count;

  return { counts, erased: { tableIds, rowIds: [...erasedRows] } };
}

/**
 * What the company still has here, by table. Held guest names are counted
 * apart (`heldGuestCopies`): they are the one thing an erasure may leave.
 *
 * `erased` (the tables and rows this run removed) lets the count also look at
 * the tables that carry no stamp and hang below a receipts table: a file
 * reference, a link or a choice of a row that is gone, a column, a view, a row
 * in the older layout, or the physical table itself.
 */
export async function countCompanyRemainder(
  db: Db,
  tenantId: string,
  workspaceIds: readonly string[],
  erased: ErasedHandles = { tableIds: [], rowIds: [] },
): Promise<{ remaining: Record<string, number>; heldGuestCopies: number; fileReferences: LeftFileReference[] }> {
  const classes = classifyModels();
  const fileReferences: LeftFileReference[] = [];
  const remaining: Record<string, number> = {};
  const add = (table: string, n: number) => {
    if (n > 0) remaining[table] = (remaining[table] ?? 0) + n;
  };
  let heldGuestCopies = 0;
  for (const model of stampedModels()) {
    const where = companyRowsWhere(model, tenantId, workspaceIds);
    if (classes[model.model] === 'guest_rule') {
      heldGuestCopies = await db.mealGuest.count({ where: { AND: [where, { contactId: null, retainUntil: { not: null } }] } });
      add(model.table, await db.mealGuest.count({ where: { AND: [where, { NOT: { contactId: null, retainUntil: { not: null } } }] } }));
      continue;
    }
    add(model.table, await delegateOf(db, model).count({ where }));
  }
  add('company_exports', await db.companyExport.count({ where: { authTenantId: tenantId } }));

  for (const part of chunks(erased.rowIds)) {
    const left = await db.dtFile.findMany({ where: { rowId: { in: part } }, select: { id: true, fileId: true }, orderBy: { id: 'asc' } });
    add('dt_files', left.length);
    for (const ref of left) if (fileReferences.length < LEFT_REFERENCES_NAMED) fileReferences.push({ referenceId: ref.id, fileId: ref.fileId });
    add('dt_relations', await db.dtRelation.count({ where: { OR: [{ sourceRowId: { in: part } }, { targetRowId: { in: part } }] } }));
    add('dt_row_select_values', await db.dtRowSelectValue.count({ where: { rowId: { in: part } } }));
  }
  if (erased.tableIds.length > 0) {
    add('dt_rows', await db.dtRow.count({ where: { tableId: { in: erased.tableIds } } }));
    add('dt_columns', await db.dtColumn.count({ where: { tableId: { in: erased.tableIds } } }));
    add('dt_views', await db.dtView.count({ where: { tableId: { in: erased.tableIds } } }));
    for (const tableId of erased.tableIds) add('receipt_row_tables', (await physicalTableExists(db, tableId)) ? 1 : 0);
  }
  return { remaining, heldGuestCopies, fileReferences };
}

/**
 * How long a dump of the database is kept at most (docs/plans/2026-10-09-production-backups.md:
 * seven days on the server, thirty days in the two copies off the server).
 */
export const BACKUP_RETENTION_DAYS = 30;

/**
 * What an erasure does not remove, said in every answer so that an
 * acknowledgement is never read as "nothing of this company exists any more".
 * Codes and numbers only.
 */
export function notErasedAfter(input: { heldGuestCopies: number; retainUntil: Date | null; storedFilesKept: number; bankSessionsLeftOpen: number }): NotErased[] {
  const out: NotErased[] = [];
  if (input.heldGuestCopies > 0) {
    out.push({ what: 'guest_copies_held', count: input.heldGuestCopies, ...(input.retainUntil ? { until: input.retainUntil.toISOString().slice(0, 10) } : {}) });
  }
  if (input.storedFilesKept > 0) out.push({ what: 'stored_files_shown_elsewhere', count: input.storedFilesKept });
  if (input.bankSessionsLeftOpen > 0) out.push({ what: 'bank_sessions_not_closed', count: input.bankSessionsLeftOpen });
  // Technical retention, not a legal one: the dumps of the database rotate out by themselves.
  out.push({ what: 'database_backups', days: BACKUP_RETENTION_DAYS });
  // An upload that never became a receipt has no row and so no company: this app cannot find it.
  out.push({ what: 'uploads_never_attached_to_a_receipt' });
  return out;
}

const guestTable = { workspaceField: 'authWorkspaceId' as const };

/**
 * The whole erasure of one company. See the module comment for the order and
 * the rules. An error it throws carries `partial`: what the run had removed
 * before it stopped, counts only.
 */
export async function eraseCompany(db: PrismaClient, tenantId: string, workspaceIds: readonly string[], deps: CompanyErasureDeps): Promise<ErasureCounts> {
  const now = deps.now ?? new Date();
  classifyModels();
  const partial: Partial<ErasureCounts> = {};
  const checkpoint = async () => {
    await deps.checkpoint?.();
  };

  try {
    await checkpoint();
    await assertStampsMatchDelivery(db, tenantId, workspaceIds);

    const contacts = await eraseCompanyContacts(db, tenantId, workspaceIds, now, deps.hasher, { holdUnlinked: true, checkpoint });
    Object.assign(partial, contacts);

    await checkpoint();
    const bank = await deps.endBankConnections(tenantId, workspaceIds);
    partial.bankConnections = bank.connections;
    await checkpoint();
    const shares = await deps.endAccountShares(tenantId, workspaceIds);
    Object.assign(partial, { accountShares: shares.shares, crossCompanyLinks: shares.links, crossCompanyRecords: shares.records });

    await checkpoint();
    partial.register = emptyRegisterCounts();
    const { counts: register, erased } = await eraseCompanyRegister(db, tenantId, workspaceIds, deps, partial.register);

    // No checkpoint from here on: everything is removed, and what is left is to count it and say so.
    const { remaining, heldGuestCopies, fileReferences } = await countCompanyRemainder(db, tenantId, workspaceIds, erased);
    const contactsLeft = await (deps.countContacts ?? (async (id: string) => (await companyContacts(id).list({ includeArchived: true })).length))(tenantId);
    if (contactsLeft > 0) remaining.shared_contacts = contactsLeft;
    if (Object.keys(remaining).length > 0) throw new ErasureIncompleteError(remaining, fileReferences);

    const latestHold =
      heldGuestCopies > 0
        ? await db.mealGuest.findFirst({
            where: { AND: [companyRowsWhere(guestTable, tenantId, workspaceIds), { contactId: null, retainUntil: { not: null } }] },
            orderBy: { retainUntil: 'desc' },
            select: { retainUntil: true },
          })
        : null;

    return {
      ...contacts,
      guestCopiesHeld: heldGuestCopies,
      bankConnections: bank.connections,
      accountShares: shares.shares,
      crossCompanyLinks: shares.links,
      crossCompanyRecords: shares.records,
      register,
      notErased: notErasedAfter({
        heldGuestCopies,
        retainUntil: latestHold?.retainUntil ?? null,
        storedFilesKept: register.storedFilesKept,
        bankSessionsLeftOpen: bank.sessionsLeftOpen,
      }),
    };
  } catch (e) {
    if (e instanceof Error && Object.keys(partial).length > 0) Object.assign(e, { partial });
    throw e;
  }
}
