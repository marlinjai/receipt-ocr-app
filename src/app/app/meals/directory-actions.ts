'use server';

import { auth } from '@/lib/auth';
import { ReceiptsAuthError, requireReceiptsSession } from '@/lib/auth-guards';
import { MissingTenantError, requireSessionTenantId, sessionWorkspaceId } from '@/lib/auth-workspace';

import { companyContacts, sharedContactsEnabled } from '@/lib/contacts/db';
import {
  DirectoryError,
  assignDirectoryCustomerNumber,
  createDirectoryContact,
  eraseDirectoryContact,
  exportDirectoryContact,
  linkPerson,
  listDirectory,
  mergeDirectoryContacts,
  updateDirectoryContact,
  type DirectoryContact,
  type DirectoryInput,
  type DirectoryKind,
  type MergeOutcome,
  type RepointResult,
} from '@/lib/contacts/directory';
import { prisma } from '@/lib/prisma';

/**
 * Server actions of the contact directory (Kontakte tab, wave 3). Each action
 * re-resolves the verified session and works only for the company of its
 * active workspace. Failures are returned with a stable code, as in
 * src/app/app/meals/actions.ts, because a thrown error loses its message in a
 * production build.
 */

export type DirectoryActionError =
  | DirectoryError['code']
  | 'directory_off'
  | 'unauthorized'
  | 'forbidden'
  | 'failed';

export type DirectoryResult<T> = { ok: true; value: T } | { ok: false; error: DirectoryActionError };

function failure(e: unknown): { ok: false; error: DirectoryActionError } {
  if (e instanceof DirectoryError) return { ok: false, error: e.code };
  if (e instanceof ReceiptsAuthError) return { ok: false, error: e.status === 401 ? 'unauthorized' : 'forbidden' };
  const status = (e as { status?: number })?.status;
  if (status === 401) return { ok: false, error: 'unauthorized' };
  if (status === 403 || e instanceof MissingTenantError) return { ok: false, error: 'forbidden' };
  console.error('[contacts] directory action failed', (e as Error)?.name ?? 'error');
  return { ok: false, error: 'failed' };
}

/** The company's contacts, for a session whose company is known. */
function contactsFor(session: Parameters<typeof sessionWorkspaceId>[0]) {
  const workspaceId = sessionWorkspaceId(session);
  const tenantId = requireSessionTenantId(session, workspaceId);
  if (!tenantId) throw new MissingTenantError();
  return companyContacts(tenantId);
}

/** The company the directory works on, for reads. */
async function readContacts() {
  if (!sharedContactsEnabled()) throw new DirectoryError('unavailable');
  return contactsFor(await requireReceiptsSession());
}

/** The same company for writes, behind the receipts write right. */
async function writeContacts() {
  if (!sharedContactsEnabled()) throw new DirectoryError('unavailable');
  return contactsFor(await auth.requireAction('receipts.row.write'));
}

export async function listDirectoryAction(includeArchived = false): Promise<DirectoryResult<DirectoryContact[]>> {
  try {
    return { ok: true, value: await listDirectory(await readContacts(), { includeArchived }) };
  } catch (e) {
    return failure(e);
  }
}

export async function createDirectoryAction(
  input: DirectoryInput & { kind: DirectoryKind; name: string },
): Promise<DirectoryResult<DirectoryContact>> {
  try {
    return { ok: true, value: await createDirectoryContact(await writeContacts(), input) };
  } catch (e) {
    return failure(e);
  }
}

export async function updateDirectoryAction(
  id: string,
  patch: DirectoryInput,
  expectedVersion: number,
): Promise<DirectoryResult<DirectoryContact>> {
  try {
    return { ok: true, value: await updateDirectoryContact(await writeContacts(), String(id), patch, expectedVersion) };
  } catch (e) {
    return failure(e);
  }
}

export async function linkPersonAction(
  personId: string,
  organizationId: string | null,
  expectedVersion: number,
): Promise<DirectoryResult<DirectoryContact>> {
  try {
    return { ok: true, value: await linkPerson(await writeContacts(), String(personId), organizationId, expectedVersion) };
  } catch (e) {
    return failure(e);
  }
}

export async function assignCustomerNumberAction(id: string): Promise<DirectoryResult<DirectoryContact>> {
  try {
    return { ok: true, value: await assignDirectoryCustomerNumber(await writeContacts(), String(id)) };
  } catch (e) {
    return failure(e);
  }
}

export async function mergeDirectoryAction(
  loserId: string,
  winnerId: string,
): Promise<DirectoryResult<{ outcome: MergeOutcome; winner: DirectoryContact } & RepointResult>> {
  try {
    const contacts = await writeContacts();
    return { ok: true, value: await mergeDirectoryContacts(contacts, prisma, String(loserId), String(winnerId)) };
  } catch (e) {
    return failure(e);
  }
}

/** One contact as JSON text, for the browser to save. */
export async function exportDirectoryAction(id: string): Promise<DirectoryResult<string>> {
  try {
    const exported = await exportDirectoryContact(await readContacts(), String(id));
    return { ok: true, value: JSON.stringify(exported, null, 2) };
  } catch (e) {
    return failure(e);
  }
}

/** Erasing one contact is not available yet; this refuses and writes nothing. */
export async function eraseDirectoryAction(): Promise<DirectoryResult<never>> {
  try {
    await writeContacts();
    eraseDirectoryContact();
  } catch (e) {
    return failure(e);
  }
  return { ok: false, error: 'unavailable' };
}
