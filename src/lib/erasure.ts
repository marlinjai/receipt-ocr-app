import 'server-only';
import type { PrismaClient } from '@prisma/client';
import { migrate } from '@marlinjai/contacts-core';
import { companyContacts, contactsDb } from './contacts/db';
import type { RegisterErasureCounts } from './company-erasure';
import { verifyErasureSignature } from './erasure-signature';

/**
 * The receiving side of auth-brain's signed `tenant.erased` webhook: what one
 * delivery does (`receiveErasureDelivery`) and the rule for a company's contact
 * data (`eraseCompanyContacts`). The whole erasure of a company, with its
 * receipts, stored files and every row that carries its stamp, is
 * `eraseCompany` in company-erasure.ts, which calls the contact rule first.
 *
 * What the contact rule removes, for the company (tenant) and the workspaces
 * auth-brain names:
 * - the printed guest copies on meals (`meal_guests`), by company, by workspace
 *   and by contact id (the id catches rows written before the company was filled);
 * - the company's contacts and its customer-number counter in the suite's shared
 *   contacts database, the only contact store.
 *
 * It is repeat-safe: a second run finds nothing and removes nothing more.
 */

/**
 * One thing an erasure did not remove, by code.
 * - `guest_copies_held`: printed guest names kept until `until`.
 * - `stored_files_shown_elsewhere`: files a receipt outside this erasure (another
 *   company's, or one in a workspace the delivery did not name) still shows.
 * - `bank_sessions_not_closed`: sessions at the bank that could not be closed. The
 *   connection is removed here and nothing is read any more; the consent at the
 *   bank runs out by itself.
 * - `database_backups`: the dumps of the database, which rotate out after `days`
 *   (technical retention, no legal one).
 * - `uploads_never_attached_to_a_receipt`: files without a row, which this app
 *   cannot assign to a company.
 */
export interface NotErased {
  what: 'guest_copies_held' | 'stored_files_shown_elsewhere' | 'bank_sessions_not_closed' | 'database_backups' | 'uploads_never_attached_to_a_receipt';
  count?: number;
  until?: string;
  days?: number;
}

export interface ErasureCounts {
  /** Printed guest copies removed now (the company's last export is identical to the register). */
  guestCopies: number;
  /**
   * Printed guest copies kept until `RETENTION_YEARS` have passed (no export that covers them).
   * From `eraseCompanyContacts`: the ones held by this run. From `eraseCompany`: every copy of the
   * company that is held after the run, also the ones an earlier run held.
   */
  guestCopiesHeld: number;
  sharedContacts: number;
  /** Why the printed copies were removed or held. A code, never a name. */
  exportCoverage: ExportCoverageReason;
  /** Live bank connections ended (session closed at the bank where it could be, connection removed). */
  bankConnections?: number;
  /** Accounts whose private payments went to another company (or came from one), ended. */
  accountShares?: number;
  /** Links one company held on another company's payments, removed with those shares. */
  crossCompanyLinks?: number;
  /** Answers, mailbox searches and finds, and messages one company kept about another company's payments, removed. */
  crossCompanyRecords?: number;
  /** The receipts tables, rows, stored files and stamped rows removed (`eraseCompany`). */
  register?: RegisterErasureCounts;
  /** What this erasure did not remove. Always answered, so an acknowledgement never claims more than was done. */
  notErased?: NotErased[];
}

/**
 * The record of every delivery and of what each run of it did (the table
 * `erasure_events`, see erasure-ledger.ts). Injected, so the rules of a delivery
 * can be tested without a database.
 */
export interface ErasureLedger {
  /**
   * Record that a run starts. Answers the workspace ids every delivery of THIS
   * event has named so far, this one included. Auth-brain sends the same body on
   * every retry; a person who sends the event again by hand may add a workspace.
   * Rejects with an `ErasureEventMismatchError` when the event id is already
   * recorded for another company: nothing is erased then.
   */
  begin(event: { eventId: string; kind: string; companyId: string; workspaceIds: readonly string[] }): Promise<{ workspaceIds: string[] }>;
  complete(eventId: string, counts: ErasureCounts): Promise<void>;
  /** `reason` is a code, `detail` table names and counts. Never a message text. */
  fail(eventId: string, reason: string, detail?: Record<string, unknown>): Promise<void>;
}

/** The event id of a delivery is already recorded for another company. */
export class ErasureEventMismatchError extends Error {
  constructor() {
    super('erasure ledger: the event id is recorded for another company');
    this.name = 'ErasureEventMismatchError';
  }
}

/**
 * The reason code of a failed run: the error's class, never its message (a
 * message can quote a value). `partial`, when the error carries it, is what the
 * run had removed before it stopped (counts only).
 */
export function erasureFailureReason(e: unknown): { reason: string; status: number; detail?: Record<string, unknown> } {
  const name = (e as Error | undefined)?.name;
  const partial = (e as { partial?: unknown } | undefined)?.partial;
  const withPartial = (detail: Record<string, unknown>) => {
    const all = { ...detail, ...(partial && typeof partial === 'object' ? { partial } : {}) };
    return Object.keys(all).length > 0 ? all : undefined;
  };
  if (name === 'ErasureConflictError') {
    const conflict = e as { kind?: string; tables?: string[] };
    return { reason: conflict.kind ?? 'rows_of_another_company', status: 502, detail: withPartial({ tables: conflict.tables ?? [] }) };
  }
  if (name === 'ErasureBusyError') return { reason: 'already_running', status: 409 };
  if (name === 'StoredFileEraseError') return { reason: 'stored_file_not_removed', status: 502, detail: withPartial({}) };
  if (name === 'ErasureChangedError') return { reason: 'changed_during_run', status: 502, detail: withPartial({}) };
  if (name === 'ErasureIncompleteError') {
    return { reason: 'rows_remain', status: 502, detail: withPartial({ remaining: (e as { remaining?: Record<string, number> }).remaining ?? {} }) };
  }
  return { reason: 'failed', status: 502, detail: withPartial({}) };
}

/**
 * How long a printed guest copy is kept when no export has been handed over.
 * Ten years is the usual period for business records under German tax law (the
 * Abgabenordnung, AO); a lawyer should confirm the period before go-live.
 */
export const RETENTION_YEARS = 10;

/** When a copy held today may be removed. */
export function retainUntilFrom(now: Date): Date {
  const until = new Date(now);
  until.setUTCFullYear(until.getUTCFullYear() + RETENTION_YEARS);
  return until;
}

/**
 * Why an export does or does not cover the printed guest names of a company.
 * Only `identical` lets them be removed; every other reason holds them.
 */
export type ExportCoverageReason =
  | 'identical' // the register as it is now equals the newest export
  | 'no_export' // the company never took an export
  | 'no_hash' // the newest export predates the register hash
  | 'changed' // the register changed after the newest export
  | 'no_workspaces' // the caller could not say which workspaces to compare
  | 'recompute_failed'; // the register could not be read now

export interface ExportCoverage {
  covered: boolean;
  reason: ExportCoverageReason;
}

/** Computes the register hash for some workspaces. Injected in tests. */
export type RegisterHasher = (db: PrismaClient, workspaceIds: readonly string[]) => Promise<string>;

/** Loaded on first use: the export module pulls in the whole meal register. */
const defaultHasher: RegisterHasher = async (db, workspaceIds) =>
  (await import('./company-export')).currentRegisterHash(db, workspaceIds);

/**
 * Does the company hold an export of the register AS IT IS NOW?
 *
 * An export only justifies removing printed guest names when it contains them.
 * An export taken before a later meal or a later correction does not, so the
 * register is recomputed and its hash compared with the one stored when the
 * newest export was taken (`company_exports.register_sha256`). Equal: covered.
 * Anything else, including a failure to recompute, is NOT covered, which holds
 * the names: the safe direction.
 *
 * `workspaceIds` must be the same scope the export was taken with. A different
 * scope gives a different hash and therefore holds.
 */
export async function exportCoversRegister(
  db: PrismaClient,
  tenantId: string,
  workspaceIds: readonly string[],
  hasher: RegisterHasher = defaultHasher,
): Promise<ExportCoverage> {
  const newest = await db.companyExport.findFirst({
    where: { authTenantId: tenantId },
    orderBy: { createdAt: 'desc' },
    select: { registerSha256: true },
  });
  if (!newest) return { covered: false, reason: 'no_export' };
  if (!newest.registerSha256) return { covered: false, reason: 'no_hash' };
  if (workspaceIds.length === 0) return { covered: false, reason: 'no_workspaces' };
  let current: string;
  try {
    current = await hasher(db, workspaceIds);
  } catch {
    return { covered: false, reason: 'recompute_failed' };
  }
  return current === newest.registerSha256 ? { covered: true, reason: 'identical' } : { covered: false, reason: 'changed' };
}

/** One condition on the printed guest copies an erasure covers. Several are combined with OR. */
export type GuestCopyScope =
  | { authTenantId: string }
  | { authWorkspaceId: { in: string[] } }
  | { contactId: string | { in: string[] } };

/**
 * THE rule for printed guest copies when their contact is erased. Used by the
 * company erasure and by the erasure of one contact, so both always decide alike.
 *
 * - `covered` (the company's newest export is identical to the register now, see
 *   `exportCoversRegister`): the copies are removed.
 * - Not covered: the copies are held. Their contact link is cleared and
 *   `retain_until` is set `RETENTION_YEARS` ahead. Only copies that carry no date
 *   yet are given one, so a repeat never restarts a hold.
 *
 * A copy that is held stays held. `covered` never removes a copy that already
 * carries a date: only the purge does, after the date. This matters for a repeat
 * of a company erasure. The first run may have held the names and removed the
 * receipts; the register is then empty, and an empty register can equal an export
 * the company took before it recorded its first meal. Without this rule the
 * second run would read "covered" and delete what the first run held.
 *
 * `holdUnlinked` (the company erasure): a printed name that never had a contact
 * is held too. Its meal goes with the company, so without a date it would stay
 * for ever. The erasure of one contact leaves such names alone: they are not
 * that contact's.
 *
 * Each case is one statement, so a run that stops never leaves the copies half settled.
 *
 * Removing copies changes the register, so the same export no longer covers a
 * LATER erasure: that one holds until a new export is taken. This is intended.
 */
export async function settleGuestCopies(
  db: PrismaClient,
  scope: readonly GuestCopyScope[],
  covered: boolean,
  now: Date = new Date(),
  options: { holdUnlinked?: boolean } = {},
): Promise<{ removed: number; held: number }> {
  if (scope.length === 0) return { removed: 0, held: 0 };
  if (covered) {
    return { removed: (await db.mealGuest.deleteMany({ where: { OR: [...scope], retainUntil: null } })).count, held: 0 };
  }
  const held = await db.mealGuest.updateMany({
    where: { OR: [...scope], retainUntil: null, ...(options.holdUnlinked ? {} : { contactId: { not: null } }) },
    data: { contactId: null, retainUntil: retainUntilFrom(now) },
  });
  return { removed: 0, held: held.count };
}

/**
 * Erase one company's contact data. Order and rules:
 *
 * 1. The contacts (in the shared contacts database) are removed, and so are the
 *    links from meals to them. Those links are not records the business must keep.
 * 2. The printed guest copies on meals (name and company as printed on the
 *    register) are the one tax-relevant part. They are removed only when the
 *    company's newest export is identical to the register as it is now
 *    (`exportCoversRegister`, compared over `workspaceIds`). Otherwise they are
 *    held (contact link cleared, `retain_until` set) until the retention period
 *    has passed; `purgeExpiredRetainedGuests` removes them.
 *
 * Repeat-safe: a second run does not restart a hold, because only copies
 * without a date are given one, and it never removes a copy an earlier run held.
 *
 * `holdUnlinked`: see `settleGuestCopies`. Set by the whole company erasure.
 */
export async function eraseCompanyContacts(
  db: PrismaClient,
  tenantId: string,
  workspaceIds: readonly string[],
  now: Date = new Date(),
  hasher?: RegisterHasher,
  options: { holdUnlinked?: boolean } = {},
): Promise<ErasureCounts> {
  // Start-up applies the layout, but it continues when the database is unreachable
  // then. migrate() is idempotent under a lock, so apply it here too: without it a
  // database that came up later would fail every retry of this delivery. A missing
  // CONTACTS_DATABASE_URL throws here, which answers 502 and makes auth-brain retry.
  await migrate(contactsDb().sql);
  const shared = companyContacts(tenantId);
  const sharedIds = (await shared.list({ includeArchived: true })).map((c) => c.id);

  const workspaceScope = workspaceIds.length > 0 ? [{ authWorkspaceId: { in: [...workspaceIds] } }] : [];
  const scope = [{ authTenantId: tenantId }, ...workspaceScope, ...(sharedIds.length > 0 ? [{ contactId: { in: sharedIds } }] : [])];

  const coverage = await exportCoversRegister(db, tenantId, workspaceIds, hasher);
  const { removed: guestCopies, held: guestCopiesHeld } = await settleGuestCopies(db, scope, coverage.covered, now, options);

  const sharedRemoved = await shared.eraseAll();

  return {
    guestCopies,
    guestCopiesHeld,
    sharedContacts: sharedRemoved,
    exportCoverage: coverage.reason,
  };
}

/**
 * Remove held printed copies whose retention period has passed. Returns how many.
 * Run it on a schedule; copies that still have a contact are never touched.
 */
export async function purgeExpiredRetainedGuests(db: PrismaClient, now: Date = new Date()): Promise<number> {
  const removed = await db.mealGuest.deleteMany({
    where: { contactId: null, retainUntil: { lt: now } },
  });
  return removed.count;
}

export interface ErasureDelivery {
  status: number;
  body: Record<string, unknown>;
}

/**
 * Decide what one signed delivery does. Pure apart from `erase` and `ledger`,
 * so the rules can be tested without the web framework.
 *
 * - Secret not configured: 503 and nothing is deleted. Auth-brain retries once it is set.
 * - Signature missing or wrong: 401 and nothing is deleted.
 * - Unparseable body: 400. No event kind: 400. No company id: 400.
 * - Any other event kind: acknowledged as ignored, so it does not wedge auth-brain.
 * - Erasure fails part way: 502 with a reason code, and auth-brain retries; the erasure is
 *   repeat-safe and goes on where it stopped. The reasons: `stored_file_not_removed` (the file
 *   store refused), `rows_of_another_company` (a named workspace holds another company's rows,
 *   nothing was erased), `rows_outside_named_workspaces` (rows with the company's stamp lie in a
 *   workspace the delivery does not name, nothing was erased), `changed_during_run` (a file was
 *   attached while the run went on), `rows_remain` (the recount found something of the company), `failed`.
 * - Another run for the same company is going on: 409 `already_running`, nothing is touched.
 * - The event id is recorded for another company: 409 `event_of_another_company`, nothing is touched.
 * - The run cannot be recorded in the ledger: 502 as well. An erasure nobody can prove is not acknowledged.
 * - 200 only when the recount found nothing of the company but held guest names. The answer
 *   lists under `notErased` what an erasure never removes or did not remove this time.
 *
 * Auth-brain keeps only the status of an answer. The counts and `notErased` are therefore also
 * written to the ledger, where they can be read later.
 *
 * The log lines carry the event id, counts and reason codes only, never names or the signature.
 */
export async function receiveErasureDelivery(input: {
  rawBody: string;
  signature: string | null | undefined;
  secret: string | undefined;
  erase: (tenantId: string, workspaceIds: readonly string[]) => Promise<ErasureCounts>;
  ledger?: ErasureLedger;
  log?: (line: string) => void;
}): Promise<ErasureDelivery> {
  const log = input.log ?? ((line: string) => console.log(line));
  if (!input.secret) {
    log('[erasure] secret not configured, refusing the delivery');
    return { status: 503, body: { error: 'Service misconfigured' } };
  }
  if (!verifyErasureSignature(input.rawBody, input.signature, input.secret)) {
    return { status: 401, body: { error: 'Invalid signature' } };
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(input.rawBody) as Record<string, unknown>;
  } catch {
    return { status: 400, body: { error: 'Malformed payload' } };
  }

  const kind = typeof payload.kind === 'string' ? payload.kind : null;
  // A body that does not say what it is is never taken for an erasure.
  if (!kind) return { status: 400, body: { error: 'Missing event kind' } };
  if (kind !== 'tenant.erased') return { status: 200, body: { ok: true, ignored: kind } };

  const tenantId = typeof payload.tenant_id === 'string' && payload.tenant_id.length > 0 ? payload.tenant_id : null;
  if (!tenantId) return { status: 400, body: { error: 'Missing company id' } };
  const named = Array.isArray(payload.workspace_ids)
    ? payload.workspace_ids.filter((id): id is string => typeof id === 'string' && id.length > 0)
    : [];
  const eventId = typeof payload.event_id === 'string' && payload.event_id.length > 0 ? payload.event_id : 'none';
  // A delivery without an id still gets one row per company, so its runs are recorded too.
  const ledgerId = eventId === 'none' ? `none:${tenantId}` : eventId;

  let workspaceIds: readonly string[] = named;
  if (input.ledger) {
    try {
      workspaceIds = (await input.ledger.begin({ eventId: ledgerId, kind: 'tenant.erased', companyId: tenantId, workspaceIds: named })).workspaceIds;
    } catch (e) {
      if (e instanceof ErasureEventMismatchError) {
        log(`[erasure] event ${eventId} is recorded for another company, nothing was erased`);
        return { status: 409, body: { error: 'Erasure refused', reason: 'event_of_another_company' } };
      }
      log(`[erasure] event ${eventId} could not be recorded (${(e as Error)?.name ?? 'error'}), nothing was erased, auth-brain will retry`);
      return { status: 502, body: { error: 'Erasure failed; will retry', reason: 'ledger_unavailable' } };
    }
  }

  let counts: ErasureCounts;
  try {
    counts = await input.erase(tenantId, workspaceIds);
  } catch (e) {
    const { reason, status, detail } = erasureFailureReason(e);
    log(`[erasure] event ${eventId} failed (${(e as Error)?.name ?? 'error'}, ${reason}${detail ? ` ${JSON.stringify(detail)}` : ''}), auth-brain will retry`);
    // The run failed already; a ledger that cannot take the note must not hide that behind its own error.
    await input.ledger?.fail(ledgerId, reason, detail).catch((le) => log(`[erasure] event ${eventId}: the failure could not be recorded (${(le as Error)?.name ?? 'error'})`));
    return { status, body: { error: 'Erasure failed; will retry', reason } };
  }

  const register = counts.register;
  const records = register ? Object.values(register.records).reduce((sum, n) => sum + n, 0) : 0;
  log(
    `[erasure] event ${eventId}: removed ${counts.guestCopies} guest copies, held ${counts.guestCopiesHeld} (export coverage: ${counts.exportCoverage}), ${counts.sharedContacts} contacts, ended ${counts.bankConnections ?? 0} bank connections and ${counts.accountShares ?? 0} account shares (${counts.crossCompanyLinks ?? 0} links and ${counts.crossCompanyRecords ?? 0} other records between companies removed)` +
      (register
        ? `, removed ${register.tables} receipts tables with ${register.receipts} rows, ${register.storedFiles} stored files (${register.storedFilesAlreadyGone} were gone already, ${register.storedFilesKept} kept because a receipt elsewhere shows them), ${records} other rows and ${register.companyExports} export records`
        : '') +
      `; not erased: ${(counts.notErased ?? []).map((n) => (n.count === undefined ? n.what : `${n.what} ${n.count}`)).join(', ') || 'not stated'}`,
  );
  if (input.ledger) {
    try {
      await input.ledger.complete(ledgerId, counts);
    } catch (e) {
      log(`[erasure] event ${eventId} erased but could not be recorded (${(e as Error)?.name ?? 'error'}), auth-brain will retry`);
      return { status: 502, body: { error: 'Erasure failed; will retry', reason: 'ledger_unavailable' } };
    }
  }
  return { status: 200, body: { ok: true, erased: counts, notErased: counts.notErased ?? [] } };
}
