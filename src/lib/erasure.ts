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
 * A company erasure removes everything of the company, the printed guest names
 * on its meals included. Keeping records for the tax period is the company's
 * duty, not this app's (decided by the owner on 2026-11-21, plan
 * docs/plans/2026-11-21-company-erasure-register.md). What survives for a while
 * is technical only: the dumps of the database.
 *
 * The erasure of ONE contact of a company that goes on existing is another
 * matter and keeps its rule (`exportCoversRegister`, `settleGuestCopies`): the
 * printed names on that company's meals are removed only when the company holds
 * an identical export, otherwise they are held for `RETENTION_YEARS`. Names held
 * that way are removed by the purge after their date, or with the company when
 * the company itself is erased.
 */

/**
 * One thing an erasure did not remove, by code.
 * - `stored_files_shown_elsewhere`: files a receipt outside this erasure (another
 *   company's, or one in a workspace the delivery did not name) still shows.
 * - `bank_sessions_not_closed`: sessions at the bank that could not be closed. The
 *   connection is removed here and nothing is read any more; the consent at the
 *   bank runs out by itself.
 * - `database_backups`: the dumps of the database keep erased rows until they rotate
 *   out: `daysOnServer` on the server, `days` at most in the copies off the server.
 *   Technical retention, no legal one. Stored files have no backup copy: a file
 *   that is erased is gone.
 * - `uploads_never_attached_to_a_receipt`: files without a row, which this app
 *   cannot assign to a company.
 */
export interface NotErased {
  what: 'stored_files_shown_elsewhere' | 'bank_sessions_not_closed' | 'database_backups' | 'uploads_never_attached_to_a_receipt';
  count?: number;
  days?: number;
  daysOnServer?: number;
}

export interface ErasureCounts {
  /**
   * Printed guest copies of the company removed now: all of them, also the ones an earlier erasure
   * of one contact had held. A company erasure holds none.
   */
  guestCopies: number;
  sharedContacts: number;
  /**
   * Printed copies outside the company's own rows (another company's meal, or a workspace the
   * delivery did not name) that named one of its contacts: their link was cleared, the copy stays.
   */
  guestLinksCleared?: number;
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
/** The right of one run to work on an erasure. Held by at most one run in the whole app. */
export interface ErasureLease {
  token: string;
  /**
   * Extends the lease. Rejects with an `ErasureLeaseLostError` when it is no longer this
   * run's (it ran out, or another run holds one): the run then stops where it is.
   */
  renew(): Promise<void>;
}

export interface ErasureLedger {
  /**
   * Record that a delivery arrived. Answers the workspace ids every delivery of THIS
   * event has named so far, this one included. Auth-brain sends the same body on
   * every retry; a person who sends an event by hand may send it again with one more.
   * Rejects with an `ErasureEventMismatchError` when the event id is already
   * recorded for another company: nothing is erased then.
   */
  begin(event: { eventId: string; kind: string; companyId: string; workspaceIds: readonly string[] }): Promise<{ workspaceIds: string[] }>;
  /**
   * Take the lease for a run on this event, or answer null when an erasure (of any
   * company) is at work. One erasure at a time in the whole app: several at once
   * would compete for the same few database connections and for the file store.
   */
  acquire(eventId: string): Promise<ErasureLease | null>;
  /** Note that a delivery found an erasure at work. Changes neither the status nor the lease. */
  busy(eventId: string): Promise<void>;
  /** Record a completed run with its counts, and give the lease back. The counts are recorded even when the lease was lost at the very end. */
  complete(eventId: string, counts: ErasureCounts, lease?: ErasureLease): Promise<void>;
  /** `reason` is a code, `detail` table names, ids and counts. Never a message text. Gives the lease back. */
  fail(eventId: string, reason: string, detail?: Record<string, unknown>, lease?: ErasureLease): Promise<void>;
  /**
   * Give the lease back and nothing else. For the case that recording a run failed: without this
   * the lease would stay in force until it runs out, and every erasure would answer 409 until then.
   */
  release(eventId: string, lease: ErasureLease): Promise<void>;
}

/** The lease of a run ran out or was taken: the run stops at its next step. */
export class ErasureLeaseLostError extends Error {
  constructor() {
    super('erasure ledger: the lease of this run is no longer held');
    this.name = 'ErasureLeaseLostError';
  }
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
    const conflict = e as { kind?: string; tables?: string[]; workspaces?: string[] };
    return {
      reason: conflict.kind ?? 'rows_of_another_company',
      status: 502,
      // The workspaces the offending rows lie in: ids only, so an operator need not query for them.
      detail: withPartial({ tables: conflict.tables ?? [], ...(conflict.workspaces ? { workspaces: conflict.workspaces } : {}) }),
    };
  }
  if (name === 'ErasureLeaseLostError') return { reason: 'lease_lost', status: 502, detail: withPartial({}) };
  if (name === 'StoredFileEraseError') return { reason: 'stored_file_not_removed', status: 502, detail: withPartial({}) };
  if (name === 'ErasureChangedError') return { reason: 'changed_during_run', status: 502, detail: withPartial({}) };
  if (name === 'ErasureIncompleteError') {
    const left = e as { remaining?: Record<string, number>; fileReferences?: unknown[] };
    return {
      reason: 'rows_remain',
      status: 502,
      // File references left below erased receipts are named (ids only): the next run cannot find
      // them any more, so this is what an operator has to go by.
      detail: withPartial({ remaining: left.remaining ?? {}, ...(left.fileReferences?.length ? { fileReferences: left.fileReferences } : {}) }),
    };
  }
  if (name === 'ErasureTablesBusyError') return { reason: 'tables_busy', status: 502, detail: withPartial({}) };
  return { reason: 'failed', status: 502, detail: withPartial({}) };
}

/**
 * How long a printed guest copy is kept when ONE contact is erased and no identical export exists.
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
  | { authWorkspaceId: { in: string[] }; authTenantId?: null }
  | { contactId: string | { in: string[] } };

/**
 * THE rule for printed guest copies when ONE contact of a company is erased
 * (`eraseContact` in contacts/directory.ts). The company goes on existing and
 * still owes its tax records, so:
 *
 * - `covered` (the company's newest export is identical to the register now, see
 *   `exportCoversRegister`): the copies are removed.
 * - Not covered: the copies are held. Their contact link is cleared and
 *   `retain_until` is set `RETENTION_YEARS` ahead. Only copies that carry no date
 *   yet are given one, so a repeat never restarts a hold.
 *
 * A copy that is held stays held: `covered` never removes a copy that already
 * carries a date, only the purge does, after the date.
 *
 * Each case is one statement, so a run that stops never leaves the copies half settled.
 *
 * Removing copies changes the register, so the same export no longer covers a
 * LATER erasure: that one holds until a new export is taken. This is intended.
 *
 * A company erasure does not use this rule: it removes the company's copies
 * outright (`eraseCompanyContacts`).
 */
export async function settleGuestCopies(
  db: PrismaClient,
  scope: readonly GuestCopyScope[],
  covered: boolean,
  now: Date = new Date(),
): Promise<{ removed: number; held: number }> {
  if (scope.length === 0) return { removed: 0, held: 0 };
  if (covered) {
    return { removed: (await db.mealGuest.deleteMany({ where: { OR: [...scope], retainUntil: null } })).count, held: 0 };
  }
  const held = await db.mealGuest.updateMany({
    where: { OR: [...scope], retainUntil: null, contactId: { not: null } },
    data: { contactId: null, retainUntil: retainUntilFrom(now) },
  });
  return { removed: 0, held: held.count };
}

/**
 * Erase one company's contact data, as part of the erasure of the whole company:
 *
 * 1. The printed guest copies on the company's meals are removed, whatever the
 *    company exported or did not export. Keeping its records is the company's
 *    duty; this app keeps nothing for it (the owner's decision of 2026-11-21).
 *    The company's own copies are the ones stamped with it and the ones without
 *    a stamp in a workspace auth-brain names.
 * 2. A copy elsewhere that names one of the company's contacts only loses that link.
 * 3. The contacts (in the shared contacts database) are removed.
 *
 * That includes a copy that already carries a date. It was held by an earlier
 * erasure of ONE contact, for a company that then still owed its records. With
 * the company erased it is the company's data like any other and goes with it.
 *
 * Repeat-safe: a second run finds nothing and removes nothing more.
 * `checkpoint`: called between the steps; it rejects when the run may not go on.
 */
export async function eraseCompanyContacts(
  db: PrismaClient,
  tenantId: string,
  workspaceIds: readonly string[],
  options: { checkpoint?: () => Promise<void> } = {},
): Promise<ErasureCounts> {
  // Start-up applies the layout, but it continues when the database is unreachable
  // then. migrate() is idempotent under a lock, so apply it here too: without it a
  // database that came up later would fail every retry of this delivery. A missing
  // CONTACTS_DATABASE_URL throws here, which answers 502 and makes auth-brain retry.
  await migrate(contactsDb().sql);
  const shared = companyContacts(tenantId);
  const sharedIds = (await shared.list({ includeArchived: true })).map((c) => c.id);

  // The company's own printed copies: stamped with the company, or without a stamp in a workspace
  // auth-brain names (rows written before the stamp existed). The same rule as for every other table.
  const workspaceScope = workspaceIds.length > 0 ? [{ authWorkspaceId: { in: [...workspaceIds] }, authTenantId: null }] : [];
  const scope = [{ authTenantId: tenantId }, ...workspaceScope];

  await options.checkpoint?.();
  // Every copy in the company's scope, with or without a date: a copy an earlier erasure of one
  // contact held was held for the company, and the company is gone.
  const guestCopies = (await db.mealGuest.deleteMany({ where: { OR: scope } })).count;

  // A printed copy OUTSIDE that scope can still name one of the company's contacts: a meal of another
  // company, or of a workspace the delivery does not name (possible after a workspace changed company
  // without its rows following). That copy is the other register's record, so it is not removed
  // here. Only its link goes, because the contact it points at is erased below.
  const guestLinksCleared =
    sharedIds.length > 0 ? (await db.mealGuest.updateMany({ where: { contactId: { in: sharedIds } }, data: { contactId: null } })).count : 0;

  await options.checkpoint?.();
  const sharedRemoved = await shared.eraseAll();

  return { guestCopies, sharedContacts: sharedRemoved, guestLinksCleared };
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
 *   attached while the run went on), `tables_busy` (another writer held the file references longer
 *   than the run waits; nothing of that table was touched), `rows_remain` (the recount found
 *   something of the company), `failed`.
 * - Another erasure (of any company) is at work: 409 `already_running`, nothing is touched and the
 *   event keeps its status. Auth-brain tries again later.
 * - The run lost its lease (it ran out, for example after the process stalled): 502 `lease_lost`;
 *   the run stopped at its next step and the next delivery goes on.
 * - The event id is recorded for another company: 409 `event_of_another_company`, nothing is touched.
 * - The run cannot be recorded in the ledger: 502 as well. An erasure nobody can prove is not acknowledged.
 * - 200 only when the recount found nothing of the company. The answer
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
  /** `checkpoint` is called between the steps of a run: it rejects when the run may not go on. */
  erase: (tenantId: string, workspaceIds: readonly string[], checkpoint: () => Promise<void>) => Promise<ErasureCounts>;
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

  // One erasure at a time in the whole app. A delivery that finds one at work touches nothing.
  let lease: ErasureLease | null | undefined;
  if (input.ledger) {
    try {
      lease = await input.ledger.acquire(ledgerId);
    } catch (e) {
      log(`[erasure] event ${eventId}: the lease could not be taken (${(e as Error)?.name ?? 'error'}), nothing was erased, auth-brain will retry`);
      return { status: 502, body: { error: 'Erasure failed; will retry', reason: 'ledger_unavailable' } };
    }
    if (!lease) {
      log(`[erasure] event ${eventId}: another erasure is at work, nothing was touched, auth-brain will retry`);
      await input.ledger.busy(ledgerId).catch((le) => log(`[erasure] event ${eventId}: the busy answer could not be recorded (${(le as Error)?.name ?? 'error'})`));
      return { status: 409, body: { error: 'Erasure failed; will retry', reason: 'already_running' } };
    }
  }
  const held = lease ?? undefined;
  /** The record of the run could not be written: give at least the lease back, so other erasures need not wait for it to run out. */
  const giveBack = async () => {
    if (!held || !input.ledger) return;
    await input.ledger.release(ledgerId, held).catch((le) => log(`[erasure] event ${eventId}: the lease could not be given back (${(le as Error)?.name ?? 'error'}), it runs out by itself`));
  };

  let counts: ErasureCounts;
  try {
    counts = await input.erase(tenantId, workspaceIds, async () => {
      await held?.renew();
    });
  } catch (e) {
    const { reason, status, detail } = erasureFailureReason(e);
    log(`[erasure] event ${eventId} failed (${(e as Error)?.name ?? 'error'}, ${reason}${detail ? ` ${JSON.stringify(detail)}` : ''}), auth-brain will retry`);
    // The run failed already; a ledger that cannot take the note must not hide that behind its own error.
    await input.ledger?.fail(ledgerId, reason, detail, held).catch(async (le) => {
      log(`[erasure] event ${eventId}: the failure could not be recorded (${(le as Error)?.name ?? 'error'})`);
      await giveBack();
    });
    return { status, body: { error: 'Erasure failed; will retry', reason } };
  }

  const register = counts.register;
  const records = register ? Object.values(register.records).reduce((sum, n) => sum + n, 0) : 0;
  log(
    `[erasure] event ${eventId}: removed ${counts.guestCopies} guest copies, ${counts.sharedContacts} contacts, ended ${counts.bankConnections ?? 0} bank connections and ${counts.accountShares ?? 0} account shares (${counts.crossCompanyLinks ?? 0} links and ${counts.crossCompanyRecords ?? 0} other records between companies removed)` +
      (register
        ? `, removed ${register.tables} receipts tables with ${register.receipts} rows, ${register.storedFiles} stored files (${register.storedFilesAlreadyGone} were gone already, ${register.storedFilesKept} kept because a receipt elsewhere shows them), ${records} other rows and ${register.companyExports} export records`
        : '') +
      `; not erased: ${(counts.notErased ?? []).map((n) => (n.count === undefined ? n.what : `${n.what} ${n.count}`)).join(', ') || 'not stated'}`,
  );
  if (input.ledger) {
    try {
      await input.ledger.complete(ledgerId, counts, held);
    } catch (e) {
      log(`[erasure] event ${eventId} erased but could not be recorded (${(e as Error)?.name ?? 'error'}), auth-brain will retry`);
      await giveBack();
      return { status: 502, body: { error: 'Erasure failed; will retry', reason: 'ledger_unavailable' } };
    }
  }
  return { status: 200, body: { ok: true, erased: counts, notErased: counts.notErased ?? [] } };
}
