import 'server-only';
import {
  ContactError as SharedError,
  formatCustomerNumber,
  type Contact as SharedContact,
  type ContactInput as SharedInput,
  type Contacts,
  type FieldDefinition,
  type FieldValues,
  type PreferredContact,
} from '@marlinjai/contacts-core';
import type { PrismaClient } from '@prisma/client';
import { exportCoversRegister, settleGuestCopies, type ExportCoverageReason, type RegisterHasher } from '../erasure';

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
  /** How the contact prefers to be reached; null when not recorded. */
  preferredContact: PreferredContact | null;
  /** Values of the company's custom fields, by field key. */
  customFields: FieldValues;
  /** Formatted for printing, for example "0025". Null until assigned. */
  customerNumber: string | null;
  archived: boolean;
  version: number;
}

/** A custom field the company defined, as the screen shows it. */
export interface DirectoryField {
  key: string;
  label: string;
  type: FieldDefinition['type'];
  options: string[] | null;
  archived: boolean;
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
  preferredContact?: string | null;
  /** A PATCH: only the keys given change, and null clears a value. */
  customFields?: Record<string, unknown>;
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
  | 'invalid_value'
  | 'unknown_field'
  | 'field_archived'
  | 'duplicate_field'
  | 'field_not_found'
  | 'unavailable';

export class DirectoryError extends Error {
  readonly code: DirectoryErrorCode;
  /** For `duplicate`: the id of the contact that already has this identity. */
  readonly existingId?: string;
  /** The input or custom field key the error is about, when the package names one. */
  readonly field?: string;
  constructor(code: DirectoryErrorCode, existingId?: string, field?: string) {
    super(code);
    this.name = 'DirectoryError';
    this.code = code;
    this.existingId = existingId;
    this.field = field;
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
  invalid_value: 'invalid_value',
  unknown_field: 'unknown_field',
  field_archived: 'field_archived',
  duplicate_field: 'duplicate_field',
  field_not_found: 'field_not_found',
};

/** Run one package call and turn its errors into directory errors. */
async function call<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof SharedError) {
      const code = SHARED_TO_DIRECTORY[e.code] ?? 'invalid';
      throw new DirectoryError(code, e.existing?.id, e.field);
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
    preferredContact: c.preferredContact,
    customFields: c.customFields,
    customerNumber: c.customerNumber === null ? null : formatCustomerNumber(c.customerNumber),
    archived: c.archived,
    version: c.version,
  };
}

/**
 * Every field of a contact, as the package's full-record update takes it. The
 * preferred contact method is part of the full record and would be wiped if left
 * out. Custom field values are a patch in the package: left out, they are kept.
 */
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
    preferredContact: c.preferredContact,
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

function presentField(d: FieldDefinition): DirectoryField {
  return { key: d.key, label: d.label, type: d.type, options: d.options, archived: d.archived };
}

/** The company's custom fields. Archived ones only on request. */
export async function listDirectoryFields(contacts: Contacts, options: { includeArchived?: boolean } = {}): Promise<DirectoryField[]> {
  return (await call(() => contacts.listFields({ includeArchived: options.includeArchived === true }))).map(presentField);
}

/** Define a custom field for the company. Its key stays taken even after archiving. */
export async function createDirectoryField(
  contacts: Contacts,
  input: { key: string; label: string; type: string; options?: readonly string[] | null },
): Promise<DirectoryField> {
  return presentField(await call(() => contacts.createField(input)));
}

/** Archive a custom field: stored values stay, new values are refused. Repeatable. */
export async function archiveDirectoryField(contacts: Contacts, key: string): Promise<DirectoryField> {
  return presentField(await call(() => contacts.archiveField(key)));
}

/** How many organizations the directory lists (archived ones are left out, as in the list). */
export async function countDirectoryOrganizations(contacts: Contacts): Promise<number> {
  return (await contacts.list({ kind: 'organization' })).length;
}

export interface ErasePreview {
  /** False when the contact is already gone (an earlier erase finished or stopped part way). */
  exists: boolean;
  /** Meals that name this contact as a guest. */
  meals: number;
  /** What happens to the printed names on those meals: see `settleGuestCopies`. */
  printedNames: 'removed' | 'held';
  /** Why: `identical` removes, every other reason holds (see `exportCoversRegister`). */
  coverage: ExportCoverageReason;
  /** For an organization: persons linked to it. They stay, unlinked. */
  linkedPersons: number;
}

/**
 * What erasing this contact would do, for the confirmation step. Writes nothing.
 * `workspaceIds` are the company's workspaces the register is compared over
 * (`companyWorkspaceIds`), the same set the export is taken with.
 */
export async function previewEraseContact(
  contacts: Contacts,
  db: PrismaClient,
  id: string,
  workspaceIds: readonly string[],
  hasher?: RegisterHasher,
): Promise<ErasePreview> {
  const exportedContact = await contacts.exportContact(id);
  // An id that is not a contact of THIS company is never looked up in the meals.
  if (!exportedContact) return { exists: false, meals: 0, printedNames: 'held', coverage: 'no_export', linkedPersons: 0 };
  const coverage = await exportCoversRegister(db, contacts.tenantId, workspaceIds, hasher);
  const rows = await db.mealGuest.findMany({ where: { contactId: id }, select: { rowId: true }, distinct: ['rowId'] });
  return {
    exists: true,
    meals: rows.length,
    printedNames: coverage.covered ? 'removed' : 'held',
    coverage: coverage.reason,
    linkedPersons: exportedContact?.members.length ?? 0,
  };
}

export interface EraseResult {
  outcome: 'erased' | 'already_erased';
  printedNamesRemoved: number;
  printedNamesHeld: number;
  /** Why the printed names were removed or held. A code, never a name. */
  coverage: ExportCoverageReason;
}

/**
 * Erase one contact for good. Two steps, each repeatable:
 * 1. Its printed copies on meals are settled by THE rule of the company erasure
 *    (`exportCoversRegister` and `settleGuestCopies` in src/lib/erasure.ts):
 *    removed only when the company's newest export is identical to the register
 *    as it is now, otherwise held with the link cleared.
 * 2. The contact record is deleted. Persons linked to an erased organization
 *    stay, unlinked (the package clears the link).
 * A run that stopped after step 1 is completed by the next run, because the
 * contact still exists then. Running it after completion reports `already_erased`
 * and changes nothing more.
 *
 * The contact must exist in THIS company before anything is touched: the printed
 * copies are keyed by contact id alone, so an id from another company (or a made-up
 * one) must never reach them.
 */
export async function eraseDirectoryContact(
  contacts: Contacts,
  db: PrismaClient,
  id: string,
  workspaceIds: readonly string[],
  now: Date = new Date(),
  hasher?: RegisterHasher,
): Promise<EraseResult> {
  if (!(await contacts.get(id))) {
    return { outcome: 'already_erased', printedNamesRemoved: 0, printedNamesHeld: 0, coverage: 'no_export' };
  }
  const coverage = await exportCoversRegister(db, contacts.tenantId, workspaceIds, hasher);
  const settled = await settleGuestCopies(db, [{ contactId: id }], coverage.covered, now);
  const erased = await call(() => contacts.erase(id));
  // The app's own table may still hold the same id from before the move.
  await db.contact.deleteMany({ where: { id, authTenantId: contacts.tenantId } });
  return {
    outcome: erased ? 'erased' : 'already_erased',
    printedNamesRemoved: settled.removed,
    printedNamesHeld: settled.held,
    coverage: coverage.reason,
  };
}
