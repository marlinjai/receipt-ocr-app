import 'server-only';
import {
  ContactError as SharedError,
  formatCustomerNumber,
  type Contact as SharedContact,
  type ContactInput as SharedInput,
  type Contacts,
} from '@marlinjai/contacts-core';
import type { PrismaClient } from '@prisma/client';

/**
 * The company's directory: persons and organizations, their links, merges,
 * customer numbers and single-contact export. Plan: docs/plans/2026-10-09-contact-screen.md.
 *
 * Works on the package's per-company `Contacts`, so every call is scoped to one
 * company. The receipts store (src/lib/contacts/shared-store.ts) stays the narrow
 * seam for the guest picker and is not used here.
 */

export type DirectoryKind = 'person' | 'organization';

export interface DirectoryContact {
  id: string;
  kind: DirectoryKind;
  name: string;
  /** Persons only: the free-text label printed next to the name. */
  companyOrRole: string;
  organizationId: string | null;
  organizationName: string | null;
  email: string | null;
  phone: string | null;
  note: string | null;
  legalForm: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  postalCode: string | null;
  city: string | null;
  country: string | null;
  vatId: string | null;
  /** Formatted for printing, for example "0025". Null until assigned. */
  customerNumber: string | null;
  archived: boolean;
  version: number;
}

export interface DirectoryInput {
  kind?: DirectoryKind;
  name?: string;
  companyOrRole?: string | null;
  organizationId?: string | null;
  email?: string | null;
  phone?: string | null;
  note?: string | null;
  legalForm?: string | null;
  addressLine1?: string | null;
  addressLine2?: string | null;
  postalCode?: string | null;
  city?: string | null;
  country?: string | null;
  vatId?: string | null;
}

export type DirectoryErrorCode =
  | 'not_found'
  | 'duplicate'
  | 'stale'
  | 'invalid'
  | 'not_organization'
  | 'same_contact'
  | 'kind_mismatch'
  | 'customer_number_conflict'
  | 'unavailable';

export class DirectoryError extends Error {
  readonly code: DirectoryErrorCode;
  /** For `duplicate`: the id of the contact that already has this identity. */
  readonly existingId?: string;
  constructor(code: DirectoryErrorCode, existingId?: string) {
    super(code);
    this.name = 'DirectoryError';
    this.code = code;
    this.existingId = existingId;
  }
}

const SHARED_TO_DIRECTORY: Record<string, DirectoryErrorCode> = {
  not_found: 'not_found',
  duplicate: 'duplicate',
  stale: 'stale',
  invalid_name: 'invalid',
  invalid_field: 'invalid',
  too_long: 'invalid',
  invalid_organization: 'invalid',
  not_organization: 'not_organization',
  merge_kind_mismatch: 'kind_mismatch',
  customer_number_conflict: 'customer_number_conflict',
};

/** Run one package call and turn its errors into directory errors. */
async function call<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof SharedError) {
      const code = SHARED_TO_DIRECTORY[e.code] ?? 'invalid';
      throw new DirectoryError(code, e.existing?.id);
    }
    throw e;
  }
}

async function organizationName(contacts: Contacts, organizationId: string | null): Promise<string | null> {
  if (!organizationId) return null;
  return (await contacts.get(organizationId))?.name ?? null;
}

async function present(contacts: Contacts, c: SharedContact): Promise<DirectoryContact> {
  return {
    id: c.id,
    kind: c.kind,
    name: c.name,
    companyOrRole: c.companyOrRole,
    organizationId: c.organizationId,
    organizationName: await organizationName(contacts, c.organizationId),
    email: c.email,
    phone: c.phone,
    note: c.note,
    legalForm: c.legalForm,
    addressLine1: c.addressLine1,
    addressLine2: c.addressLine2,
    postalCode: c.postalCode,
    city: c.city,
    country: c.country,
    vatId: c.vatId,
    customerNumber: c.customerNumber === null ? null : formatCustomerNumber(c.customerNumber),
    archived: c.archived,
    version: c.version,
  };
}

/** Every field of a contact, as the package's full-record update takes it. */
function carry(c: SharedContact): SharedInput {
  return {
    kind: c.kind,
    name: c.name,
    companyOrRole: c.companyOrRole,
    organizationId: c.organizationId,
    email: c.email,
    phone: c.phone,
    note: c.note,
    legalForm: c.legalForm,
    addressLine1: c.addressLine1,
    addressLine2: c.addressLine2,
    postalCode: c.postalCode,
    city: c.city,
    country: c.country,
    vatId: c.vatId,
  };
}

/** Drop the fields the caller did not give, so an absent field keeps its value. */
function given(patch: DirectoryInput): DirectoryInput {
  return Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) as DirectoryInput;
}

export async function listDirectory(contacts: Contacts, options: { includeArchived?: boolean } = {}): Promise<DirectoryContact[]> {
  const rows = await contacts.list({ includeArchived: options.includeArchived === true });
  return Promise.all(rows.map((c) => present(contacts, c)));
}

export async function createDirectoryContact(
  contacts: Contacts,
  input: DirectoryInput & { kind: DirectoryKind; name: string },
): Promise<DirectoryContact> {
  const created = await call(() => contacts.create(input as SharedInput));
  return present(contacts, created);
}

/**
 * Edit a contact. Fields not given keep their value. `expectedVersion` is the
 * version the caller read; a save based on an older version is refused as `stale`.
 * The kind cannot change.
 */
export async function updateDirectoryContact(
  contacts: Contacts,
  id: string,
  patch: DirectoryInput,
  expectedVersion?: number,
): Promise<DirectoryContact> {
  const current = await contacts.get(id);
  if (!current) throw new DirectoryError('not_found');
  if (patch.kind !== undefined && patch.kind !== current.kind) throw new DirectoryError('invalid');
  const next = { ...carry(current), ...given(patch), kind: current.kind } as SharedInput;
  const updated = await call(() => contacts.update(id, next, { expectedVersion: expectedVersion ?? current.version }));
  return present(contacts, updated);
}

/** Link a person to an organization in the same company, or unlink with null. */
export async function linkPerson(
  contacts: Contacts,
  personId: string,
  organizationId: string | null,
  expectedVersion?: number,
): Promise<DirectoryContact> {
  if (organizationId !== null) {
    const org = await contacts.get(organizationId);
    if (!org) throw new DirectoryError('not_found');
    if (org.kind !== 'organization') throw new DirectoryError('not_organization');
  }
  return updateDirectoryContact(contacts, personId, { organizationId }, expectedVersion);
}

/** Give the contact the company's next customer number. A number is never reused. */
export async function assignDirectoryCustomerNumber(contacts: Contacts, id: string): Promise<DirectoryContact> {
  const updated = await call(() => contacts.assignCustomerNumber(id));
  return present(contacts, updated);
}

/** Everything held about one contact, as the package exports it. */
export async function exportDirectoryContact(contacts: Contacts, id: string) {
  const exported = await contacts.exportContact(id);
  if (!exported) throw new DirectoryError('not_found');
  return exported;
}

export interface RepointResult {
  repointed: number;
  deduplicated: number;
}

/**
 * Point the meal guest rows that name `fromId` at `toId`. A row that already names
 * `toId` on the same meal is removed instead, so no meal lists one guest twice.
 * Printed names are not touched. Repeatable: rows already moved are not found again.
 */
export async function repointGuestRows(db: PrismaClient, fromId: string, toId: string): Promise<RepointResult> {
  const rows = await db.mealGuest.findMany({ where: { contactId: fromId }, select: { id: true, rowId: true } });
  let repointed = 0;
  let deduplicated = 0;
  for (const row of rows) {
    const clash = await db.mealGuest.findFirst({ where: { rowId: row.rowId, contactId: toId }, select: { id: true } });
    if (clash) {
      await db.mealGuest.deleteMany({ where: { id: row.id } });
      deduplicated++;
    } else {
      await db.mealGuest.updateMany({ where: { id: row.id, contactId: fromId }, data: { contactId: toId } });
      repointed++;
    }
  }
  return { repointed, deduplicated };
}

export type MergeOutcome = 'merged' | 'already_merged';

/**
 * Merge `loserId` into `winnerId`. Two steps, each repeatable:
 * 1. The package folds the loser into the winner and deletes the loser. Skipped
 *    when the loser is already gone (an earlier run did this step).
 * 2. The meal guest rows that name the loser are pointed at the winner.
 * A run that stopped after step 1 is completed by the next run. Running it after
 * completion reports `already_merged` and changes nothing more.
 */
export async function mergeDirectoryContacts(
  contacts: Contacts,
  db: PrismaClient,
  loserId: string,
  winnerId: string,
): Promise<{ outcome: MergeOutcome; winner: DirectoryContact } & RepointResult> {
  if (loserId === winnerId) throw new DirectoryError('same_contact');
  const winner = await contacts.get(winnerId);
  if (!winner) throw new DirectoryError('not_found');
  const loser = await contacts.get(loserId);
  let outcome: MergeOutcome = 'already_merged';
  if (loser) {
    if (loser.kind !== winner.kind) throw new DirectoryError('kind_mismatch');
    await call(() => contacts.merge(loserId, winnerId));
    outcome = 'merged';
  }
  const repoint = await repointGuestRows(db, loserId, winnerId);
  const current = await contacts.get(winnerId);
  return { outcome, winner: await present(contacts, current!), ...repoint };
}

/**
 * Erasing one contact is shown in the screen but not available yet: its printed
 * copies on meals follow the company erasure rule, which is being built on its own
 * (roadmap: "Company erasure hands over an export first"). Until then this refuses
 * and writes nothing.
 */
export function eraseDirectoryContact(): never {
  throw new DirectoryError('unavailable');
}
