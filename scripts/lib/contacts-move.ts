import { contactIdentityKey, type Contact as SharedContact, type Contacts } from '@marlinjai/contacts-core';
import type { PrismaClient } from '@prisma/client';

/**
 * The data move from the receipts app's own `contacts` table into the suite's
 * shared contacts database (wave 2, see docs/plans/2026-10-09-shared-contacts-wave2.md).
 *
 * Rules:
 * - One company at a time. A row belongs to the company it names, or, when it
 *   names none, to the company given for its workspace (never inferred).
 * - Identical entries of one company (same name and company or role, compared
 *   the way the shared package compares them) become ONE contact. The winner is
 *   an active entry over an archived one, then the earliest created.
 * - The winner keeps its old id, so meal guests that already name it need no
 *   change. Losers' guest rows are repointed to the winner. A guest row that would
 *   then duplicate a (meal row, contact) pair is removed instead.
 * - Nothing is deleted from the old table here. Its removal is a later wave.
 * - Re-running is safe at every point: a finished company reports zero new work,
 *   and an interrupted one picks up where it stopped.
 *
 * Lives in scripts/ (not src/) because the production image ships scripts/ and not src/.
 * It imports no server-only code, so the command scripts/move-contacts.ts can run it.
 */

/** A row of the receipts app's own contacts table, the fields the move reads. */
export interface OldContact {
  id: string;
  authWorkspaceId: string;
  authTenantId: string | null;
  name: string;
  companyOrRole: string;
  note: string | null;
  archivedAt: Date | null;
  createdAt: Date;
}

export interface MoveGroup {
  tenant: string;
  winner: OldContact;
  losers: OldContact[];
}

export interface MovePlan {
  /** Groups per company, companies in id order, groups in first-seen order. */
  groups: Map<string, MoveGroup[]>;
  /** Rows that name no company and whose workspace has no mapping. The move refuses to run while any exist. */
  skippedNoTenant: number;
}

/**
 * Group the old rows into the contacts they will become. Pure: no database.
 * `workspaceTenants` maps a workspace to its company for rows that name none.
 */
export function planMove(contacts: readonly OldContact[], workspaceTenants: ReadonlyMap<string, string>): MovePlan {
  const byKey = new Map<string, { tenant: string; members: OldContact[] }>();
  let skippedNoTenant = 0;
  for (const c of contacts) {
    const tenant = c.authTenantId ?? workspaceTenants.get(c.authWorkspaceId) ?? null;
    if (!tenant) {
      skippedNoTenant++;
      continue;
    }
    const key = `${tenant}\u0000${contactIdentityKey('person', c.name, c.companyOrRole)}`;
    const entry = byKey.get(key) ?? { tenant, members: [] };
    entry.members.push(c);
    byKey.set(key, entry);
  }

  const groups = new Map<string, MoveGroup[]>();
  for (const { tenant, members } of byKey.values()) {
    // Active first, then earliest created, then id, so the choice never depends on row order.
    const ordered = [...members].sort(
      (a, b) =>
        Number(a.archivedAt !== null) - Number(b.archivedAt !== null) ||
        a.createdAt.getTime() - b.createdAt.getTime() ||
        a.id.localeCompare(b.id),
    );
    const list = groups.get(tenant) ?? [];
    list.push({ tenant, winner: ordered[0], losers: ordered.slice(1) });
    groups.set(tenant, list);
  }
  const sorted = new Map([...groups.entries()].sort(([a], [b]) => a.localeCompare(b)));
  return { groups: sorted, skippedNoTenant };
}

export interface CompanyCounts {
  tenant: string;
  oldContacts: number;
  groups: number;
  /** Losers folded into a winner. */
  merged: number;
  /** Groups whose winner is already in the shared database (an earlier run, or the same entry created there). */
  alreadyMoved: number;
  /** Winners created in the shared database. Always 0 in a dry run. */
  created: number;
  /** Winner was archived: archived in the shared database too. */
  archived: number;
  /** A winner took a note from a loser that had one. */
  noteFilled: number;
  /** Guest rows pointed at the contact the company now holds. */
  guestRowsRepointed: number;
  /** Guest rows removed because the same meal already named the contact. */
  guestRowsDeduplicated: number;
  /** Guest rows that a dry run would repoint or remove. */
  guestRowsPending: number;
}

export interface MoveDeps {
  /** The company's contacts in the shared database. */
  shared: Contacts;
  /** The receipts app's database (meal guests). */
  db: PrismaClient;
  apply: boolean;
  /** Tests only: called after each group, to stop a run part way. */
  afterGroup?: (group: MoveGroup) => Promise<void> | void;
}

/** Every field of a shared contact, as the package's full-record update takes it. */
function fullRecord(c: SharedContact, note: string | null) {
  return {
    kind: 'person' as const,
    name: c.name,
    companyOrRole: c.companyOrRole,
    note,
    organizationId: c.organizationId,
    email: c.email,
    phone: c.phone,
    legalForm: c.legalForm,
    addressLine1: c.addressLine1,
    addressLine2: c.addressLine2,
    postalCode: c.postalCode,
    city: c.city,
    country: c.country,
    vatId: c.vatId,
  };
}

/** Move one company's groups. Writes only when `deps.apply` is set. */
export async function moveCompany(groups: readonly MoveGroup[], deps: MoveDeps): Promise<CompanyCounts> {
  const tenant = groups[0]?.tenant ?? '';
  const counts: CompanyCounts = {
    tenant,
    oldContacts: groups.reduce((n, g) => n + 1 + g.losers.length, 0),
    groups: groups.length,
    merged: 0,
    alreadyMoved: 0,
    created: 0,
    archived: 0,
    noteFilled: 0,
    guestRowsRepointed: 0,
    guestRowsDeduplicated: 0,
    guestRowsPending: 0,
  };

  for (const group of groups) {
    counts.merged += group.losers.length;
    const winner = group.winner;

    if (!deps.apply) {
      // Only the losers' rows move; the winner's rows already name the winner.
      const loserIds = group.losers.map((l) => l.id);
      if (loserIds.length > 0) {
        counts.guestRowsPending += await deps.db.mealGuest.count({ where: { contactId: { in: loserIds } } });
      }
      if ((await deps.shared.get(winner.id)) || (await deps.shared.findSame({ kind: 'person', name: winner.name, companyOrRole: winner.companyOrRole }))) {
        counts.alreadyMoved++;
      }
      continue;
    }

    // 1. The winner in the shared database: reuse it if an earlier run made it, or if
    //    the same identity already exists there under another id; otherwise create it under its own id.
    let shared = await deps.shared.get(winner.id);
    if (shared) {
      counts.alreadyMoved++;
    } else {
      const same = await deps.shared.findSame({ kind: 'person', name: winner.name, companyOrRole: winner.companyOrRole });
      if (same) {
        shared = same;
        counts.alreadyMoved++;
      } else {
        shared = await deps.shared.create(
          { kind: 'person', name: winner.name, companyOrRole: winner.companyOrRole, note: winner.note },
          { id: winner.id },
        );
        counts.created++;
      }
    }
    const sharedId = shared.id;

    // 2. A winner archived in the old table stays archived. The archive is repeatable.
    if (winner.archivedAt && !shared.archived) {
      await deps.shared.archive(sharedId);
      counts.archived++;
    }

    // 3. A note the winner lacks is taken from the first loser that has one.
    const donor = group.losers.find((l) => l.note && l.note.length > 0);
    const current = await deps.shared.get(sharedId);
    if (donor && current && !current.note) {
      await deps.shared.update(sharedId, fullRecord(current, donor.note), { expectedVersion: current.version });
      counts.noteFilled++;
    }

    // 4. Guest rows named after a loser (or after the winner, if the shared contact
    //    got another id) name the contact now. A row that would duplicate a meal's
    //    pair is removed, so no meal lists the same guest twice.
    const sourceIds = [winner.id, ...group.losers.map((l) => l.id)].filter((id) => id !== sharedId);
    for (const oldId of sourceIds) {
      const rows = await deps.db.mealGuest.findMany({ where: { contactId: oldId }, select: { id: true, rowId: true } });
      for (const row of rows) {
        const clash = await deps.db.mealGuest.findFirst({
          where: { rowId: row.rowId, contactId: sharedId },
          select: { id: true },
        });
        if (clash) {
          await deps.db.mealGuest.deleteMany({ where: { id: row.id } });
          counts.guestRowsDeduplicated++;
        } else {
          await deps.db.mealGuest.updateMany({ where: { id: row.id }, data: { contactId: sharedId } });
          counts.guestRowsRepointed++;
        }
      }
    }

    if (deps.afterGroup) await deps.afterGroup(group);
  }

  return counts;
}
