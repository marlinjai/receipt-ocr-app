'use server';

import { auth } from '@/lib/auth';
import { ReceiptsAuthError, requireReceiptsSession } from '@/lib/auth-guards';
import { MissingTenantError, companyWorkspaceIds, requireSessionTenantId, sessionWorkspaceId } from '@/lib/auth-workspace';

import { companyContacts } from '@/lib/contacts/db';
import {
  DirectoryError,
  archiveDirectoryField,
  assignDirectoryCustomerNumber,
  createDirectoryContact,
  createDirectoryField,
  eraseDirectoryContact,
  exportDirectoryContact,
  linkPerson,
  listDirectory,
  listDirectoryFields,
  mergeDirectoryContacts,
  previewEraseContact,
  updateDirectoryContact,
  type DirectoryContact,
  type DirectoryField,
  type DirectoryInput,
  type DirectoryKind,
  type ErasePreview,
  type EraseResult,
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
  | 'unauthorized'
  | 'forbidden'
  | 'failed';

/** `field` names the input or custom field key the error is about, when there is one. */
export type DirectoryResult<T> = { ok: true; value: T } | { ok: false; error: DirectoryActionError; field?: string };

function failure(e: unknown): { ok: false; error: DirectoryActionError; field?: string } {
  if (e instanceof DirectoryError) return { ok: false, error: e.code, field: e.field };
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
  return contactsFor(await requireReceiptsSession());
}

/** The same company for writes, behind the receipts write right. */
async function writeContacts() {
  return contactsFor(await auth.requireAction('receipts.row.write'));
}

/**
 * The company for an erase, with the workspaces its register is compared over:
 * the same set the company export is taken with (`companyWorkspaceIds`).
 */
async function eraseScope() {
  const session = await auth.requireAction('receipts.row.write');
  const contacts = contactsFor(session);
  return { contacts, workspaceIds: companyWorkspaceIds(session, contacts.tenantId) };
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

/** The company's custom fields, archived ones included so the screen can show them as such. */
export async function listFieldsAction(): Promise<DirectoryResult<DirectoryField[]>> {
  try {
    return { ok: true, value: await listDirectoryFields(await readContacts(), { includeArchived: true }) };
  } catch (e) {
    return failure(e);
  }
}

export async function createFieldAction(input: {
  key: string;
  label: string;
  type: string;
  options?: string[] | null;
}): Promise<DirectoryResult<DirectoryField>> {
  try {
    return {
      ok: true,
      value: await createDirectoryField(await writeContacts(), {
        key: String(input?.key ?? ''),
        label: String(input?.label ?? ''),
        type: String(input?.type ?? ''),
        options: Array.isArray(input?.options) ? input.options.map(String) : null,
      }),
    };
  } catch (e) {
    return failure(e);
  }
}

export async function archiveFieldAction(key: string): Promise<DirectoryResult<DirectoryField>> {
  try {
    return { ok: true, value: await archiveDirectoryField(await writeContacts(), String(key)) };
  } catch (e) {
    return failure(e);
  }
}

/** What erasing this contact would do. Writes nothing; shown before the confirmation. */
export async function previewEraseAction(id: string): Promise<DirectoryResult<ErasePreview>> {
  try {
    const { contacts, workspaceIds } = await eraseScope();
    return { ok: true, value: await previewEraseContact(contacts, prisma, String(id), workspaceIds) };
  } catch (e) {
    return failure(e);
  }
}

/**
 * Erase one contact for good. Its printed names on meals follow the same rule as
 * the company erasure (src/lib/erasure.ts): removed only when the company's newest
 * export is identical to the register as it is now, otherwise held. Repeating it
 * changes nothing more. The log line carries the reason code, never a name.
 */
export async function eraseDirectoryAction(id: string): Promise<DirectoryResult<EraseResult>> {
  try {
    const { contacts, workspaceIds } = await eraseScope();
    const result = await eraseDirectoryContact(contacts, prisma, String(id), workspaceIds);
    console.log(
      `[contacts] erase one contact: ${result.outcome}, printed names removed ${result.printedNamesRemoved}, held ${result.printedNamesHeld} (export coverage: ${result.coverage})`,
    );
    return { ok: true, value: result };
  } catch (e) {
    return failure(e);
  }
}
