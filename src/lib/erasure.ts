import 'server-only';
import type { PrismaClient } from '@prisma/client';
import { migrate } from '@marlinjai/contacts-core';
import { companyContacts, contactsDb } from './contacts/db';
import { verifyErasureSignature } from './erasure-signature';

/**
 * GDPR erasure of one company's contact data, the receiving side of auth-brain's
 * signed `tenant.erased` webhook.
 *
 * What it removes, for the company (tenant) and the workspaces auth-brain names:
 * - the printed guest copies on meals (`meal_guests`), by company, by workspace
 *   and by contact id (the id catches rows written before the company was filled);
 * - the company's contacts and its customer-number counter in the suite's shared
 *   contacts database, the only contact store.
 *
 * It is repeat-safe: a second run finds nothing and removes nothing more.
 *
 * Not covered here: the register rows and their stored receipt files in the
 * data layer. Those are a separate decision (see the plan), and this receiver
 * does not pretend to erase them.
 */

export interface ErasureCounts {
  /** Printed guest copies removed now (the company's last export is identical to the register). */
  guestCopies: number;
  /** Printed guest copies kept until `RETENTION_YEARS` have passed (no export that covers them). */
  guestCopiesHeld: number;
  sharedContacts: number;
  /** Why the printed copies were removed or held. A code, never a name. */
  exportCoverage: ExportCoverageReason;
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
 *   `retain_until` is set `RETENTION_YEARS` ahead. Only copies still linked to a
 *   contact are given a date, so a repeat never restarts a hold.
 *
 * Removing copies changes the register, so the same export no longer covers a
 * LATER erasure: that one holds until a new export is taken. This is intended.
 */
export async function settleGuestCopies(
  db: PrismaClient,
  scope: readonly GuestCopyScope[],
  covered: boolean,
  now: Date = new Date(),
): Promise<{ removed: number; held: number }> {
  if (scope.length === 0) return { removed: 0, held: 0 };
  if (covered) {
    return { removed: (await db.mealGuest.deleteMany({ where: { OR: [...scope] } })).count, held: 0 };
  }
  const held = await db.mealGuest.updateMany({
    where: { OR: [...scope], contactId: { not: null } },
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
 * Repeat-safe: a second run does not restart a hold, because only copies still
 * linked to a contact are given one.
 */
export async function eraseCompanyContacts(
  db: PrismaClient,
  tenantId: string,
  workspaceIds: readonly string[],
  now: Date = new Date(),
  hasher?: RegisterHasher,
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
  const { removed: guestCopies, held: guestCopiesHeld } = await settleGuestCopies(db, scope, coverage.covered, now);

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
 * Decide what one signed delivery does. Pure apart from `erase`, so the rules
 * can be tested without the web framework.
 *
 * - Secret not configured: 503 and nothing is deleted. Auth-brain retries once it is set.
 * - Signature missing or wrong: 401 and nothing is deleted.
 * - Unparseable body: 400. No company id: 400.
 * - Any other event kind: acknowledged as ignored, so it does not wedge auth-brain.
 * - Erasure fails part way: 502, and auth-brain retries; the erasure is repeat-safe.
 *
 * The log lines carry the event id and counts only, never names or the signature.
 */
export async function receiveErasureDelivery(input: {
  rawBody: string;
  signature: string | null | undefined;
  secret: string | undefined;
  erase: (tenantId: string, workspaceIds: readonly string[]) => Promise<ErasureCounts>;
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
  if (kind && kind !== 'tenant.erased') return { status: 200, body: { ok: true, ignored: kind } };

  const tenantId = typeof payload.tenant_id === 'string' && payload.tenant_id.length > 0 ? payload.tenant_id : null;
  if (!tenantId) return { status: 400, body: { error: 'Missing company id' } };
  const workspaceIds = Array.isArray(payload.workspace_ids)
    ? payload.workspace_ids.filter((id): id is string => typeof id === 'string' && id.length > 0)
    : [];
  const eventId = typeof payload.event_id === 'string' ? payload.event_id : 'none';

  try {
    const counts = await input.erase(tenantId, workspaceIds);
    log(
      `[erasure] event ${eventId}: removed ${counts.guestCopies} guest copies, held ${counts.guestCopiesHeld} (export coverage: ${counts.exportCoverage}), ${counts.sharedContacts} contacts`,
    );
    return { status: 200, body: { ok: true, erased: counts } };
  } catch (e) {
    log(`[erasure] event ${eventId} failed (${(e as Error)?.name ?? 'error'}), auth-brain will retry`);
    return { status: 502, body: { error: 'Erasure failed; will retry' } };
  }
}
