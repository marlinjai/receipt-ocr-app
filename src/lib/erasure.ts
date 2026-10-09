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
 * - the app's own `contacts` table (kept until the clean-up wave removes it);
 * - the company's contacts and its customer-number counter in the suite's shared
 *   contacts database, when `CONTACTS_DATABASE_URL` is set.
 *
 * The shared step runs whenever the database is configured, NOT only when
 * `CONTACTS_STORE=shared`: the data move writes into that database while the
 * switch is still off, so erasure has to reach it either way.
 *
 * It is repeat-safe: a second run finds nothing and removes nothing more.
 *
 * Not covered here: the register rows and their stored receipt files in the
 * data layer. Those are a separate decision (see the plan), and this receiver
 * does not pretend to erase them.
 */

export interface ErasureCounts {
  /** Printed guest copies removed now (the company already holds an export). */
  guestCopies: number;
  /** Printed guest copies kept until `RETENTION_YEARS` have passed (no export yet). */
  guestCopiesHeld: number;
  ownContacts: number;
  sharedContacts: number;
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
 * Erase one company's contact data. Order and rules:
 *
 * 1. The contacts (app table and shared database) are removed, and so are the
 *    links from meals to them. Those links are not records the business must keep.
 * 2. The printed guest copies on meals (name and company as printed on the
 *    register) are the one tax-relevant part. If the company already has an
 *    export on record, they are removed too, because the company holds the
 *    export. If not, they are held (contact link cleared, `retain_until` set)
 *    until the retention period has passed; `purgeExpiredRetainedGuests` removes them.
 *
 * Repeat-safe: a second run does not restart a hold, because only copies still
 * linked to a contact are given one.
 */
export async function eraseCompanyContacts(
  db: PrismaClient,
  tenantId: string,
  workspaceIds: readonly string[],
  now: Date = new Date(),
): Promise<ErasureCounts> {
  // The shared step needs the layout. Start-up applies it only while the switch
  // is on, so apply it here too: migrate() is idempotent under a lock, and without
  // it an older database would fail every retry of this delivery.
  const configured = Boolean(process.env.CONTACTS_DATABASE_URL?.trim());
  if (configured) await migrate(contactsDb().sql);
  const shared = configured ? companyContacts(tenantId) : null;
  const sharedIds = shared ? (await shared.list({ includeArchived: true })).map((c) => c.id) : [];

  const workspaceScope = workspaceIds.length > 0 ? [{ authWorkspaceId: { in: [...workspaceIds] } }] : [];
  const scope = [{ authTenantId: tenantId }, ...workspaceScope, ...(sharedIds.length > 0 ? [{ contactId: { in: sharedIds } }] : [])];

  const exported = (await db.companyExport.count({ where: { authTenantId: tenantId } })) > 0;

  let guestCopies = 0;
  let guestCopiesHeld = 0;
  if (exported) {
    // The company holds the export, so nothing of its guest data is kept here.
    guestCopies = (await db.mealGuest.deleteMany({ where: { OR: scope } })).count;
  } else {
    // Hold only copies still linked to a contact; a copy already held keeps its date.
    guestCopiesHeld = (
      await db.mealGuest.updateMany({
        where: { OR: scope, contactId: { not: null } },
        data: { contactId: null, retainUntil: retainUntilFrom(now) },
      })
    ).count;
  }

  const ownContacts = await db.contact.deleteMany({
    where: { OR: [{ authTenantId: tenantId }, ...workspaceScope] },
  });
  const sharedRemoved = shared ? await shared.eraseAll() : 0;

  return {
    guestCopies,
    guestCopiesHeld,
    ownContacts: ownContacts.count,
    sharedContacts: sharedRemoved,
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
      `[erasure] event ${eventId}: removed ${counts.guestCopies} guest copies, held ${counts.guestCopiesHeld}, ${counts.ownContacts} own contacts, ${counts.sharedContacts} shared contacts`,
    );
    return { status: 200, body: { ok: true, erased: counts } };
  } catch (e) {
    log(`[erasure] event ${eventId} failed (${(e as Error)?.name ?? 'error'}), auth-brain will retry`);
    return { status: 502, body: { error: 'Erasure failed; will retry' } };
  }
}
