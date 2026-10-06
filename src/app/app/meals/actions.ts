'use server';

import type { AppSession } from '@marlinjai/auth-brain-nextjs';
import { auth } from '@/lib/auth';
import { ReceiptsAuthError, requireReceiptsSession, requireRowAccess } from '@/lib/auth-guards';
import { MissingTenantError, requireSessionTenantId, sessionWorkspaceId } from '@/lib/auth-workspace';
import { ContactError, type Contact, type ContactInput } from '@/lib/contacts/store';
import { MealInputError, type MealDetailsInput } from '@/lib/meals/input';
import {
  MealServiceError,
  contactStore,
  getTaxSettings,
  TaxSettingsError,
  lastUsedHost,
  loadLastUsedHost,
  loadMealRecord,
  loadMealRecords,
  saveMealDetails,
  saveTaxSettings,
  type MealContext,
  type TaxSettingsInput,
} from '@/lib/meals/service';
import type { MealRecord, MealTaxSettings } from '@/lib/meals/types';
import { prisma } from '@/lib/prisma';

/**
 * Server actions of the meal register.
 *
 * Every action re-resolves the verified session; the workspace is the
 * session's ACTIVE one and is never taken from the browser. Writes pass the
 * fail-closed `receipts.row.write` check.
 *
 * Failures are RETURNED as `{ ok: false, error }` with a stable code, not
 * thrown: in a production build a thrown server-action error reaches the
 * browser with its message stripped, and the form could then only say
 * "something went wrong". The codes are turned into wording on the client.
 */

export type MealActionError =
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'invalid_input'
  | 'contact_duplicate'
  | 'contact_invalid'
  | 'contact_archived'
  | 'not_initialized'
  | 'failed';

export type Result<T> = { ok: true; value: T } | { ok: false; error: MealActionError; detail?: string };

function failure(e: unknown): { ok: false; error: MealActionError; detail?: string } {
  if (e instanceof ReceiptsAuthError) {
    return { ok: false, error: e.status === 401 ? 'unauthorized' : e.status === 404 ? 'not_found' : 'forbidden' };
  }
  const status = (e as { status?: number })?.status;
  if (status === 401) return { ok: false, error: 'unauthorized' };
  if (status === 403) return { ok: false, error: 'forbidden' };
  if (e instanceof MissingTenantError) return { ok: false, error: 'forbidden' };
  if (e instanceof MealInputError) return { ok: false, error: 'invalid_input', detail: e.code };
  if (e instanceof ContactError) {
    if (e.code === 'duplicate') return { ok: false, error: 'contact_duplicate', detail: e.existing?.id };
    if (e.code === 'not_found') return { ok: false, error: 'not_found' };
    return { ok: false, error: 'contact_invalid', detail: e.code };
  }
  if (e instanceof MealServiceError) {
    if (e.code === 'row_not_found' || e.code === 'unknown_contact') return { ok: false, error: 'not_found', detail: e.code };
    if (e.code === 'archived_contact') return { ok: false, error: 'contact_archived' };
    if (e.code === 'not_initialized' || e.code === 'schema_outdated') {
      return { ok: false, error: 'not_initialized', detail: e.code };
    }
  }
  console.error('[meals] action failed', e);
  return { ok: false, error: 'failed' };
}

function readContext(session: AppSession): string {
  return sessionWorkspaceId(session);
}

async function writeContext(): Promise<MealContext> {
  const session = await auth.requireAction('receipts.row.write');
  const workspaceId = sessionWorkspaceId(session);
  return { workspaceId, tenantId: requireSessionTenantId(session, workspaceId) };
}

export interface MealsPageData {
  records: MealRecord[];
  contacts: Contact[];
  settings: MealTaxSettings;
  /** The host name used most recently, to prefill a new entry. */
  defaultHost: string;
}

export async function getMealsPageData(): Promise<Result<MealsPageData>> {
  try {
    const session = await requireReceiptsSession();
    const workspaceId = readContext(session);
    const [records, contacts, settings] = await Promise.all([
      loadMealRecords(prisma, workspaceId),
      contactStore(prisma, { workspaceId, tenantId: null }).list({ includeArchived: true }),
      getTaxSettings(prisma, workspaceId),
    ]);
    return { ok: true, value: { records, contacts, settings, defaultHost: lastUsedHost(records) } };
  } catch (e) {
    return failure(e);
  }
}

export interface MealForRow {
  record: MealRecord;
  contacts: Contact[];
  settings: MealTaxSettings;
  defaultHost: string;
}

/** Everything the form needs for one row (used by the receipt detail panel). */
export async function getMealForRow(rowId: string): Promise<Result<MealForRow>> {
  try {
    const { session } = await requireRowAccess(String(rowId));
    const workspaceId = readContext(session);
    const record = await loadMealRecord(prisma, workspaceId, String(rowId));
    // A row of another workspace the user is also a member of: not this workspace's meal.
    if (!record) return { ok: false, error: 'not_found' };
    const [contacts, settings, defaultHost] = await Promise.all([
      contactStore(prisma, { workspaceId, tenantId: null }).list({ includeArchived: true }),
      getTaxSettings(prisma, workspaceId),
      loadLastUsedHost(prisma, workspaceId),
    ]);
    return { ok: true, value: { record, contacts, settings, defaultHost } };
  } catch (e) {
    return failure(e);
  }
}

export async function saveMeal(
  rowId: string,
  input: MealDetailsInput,
): Promise<Result<{ record: MealRecord; changed: boolean }>> {
  try {
    const ctx = await writeContext();
    return { ok: true, value: await saveMealDetails(prisma, ctx, String(rowId), input) };
  } catch (e) {
    return failure(e);
  }
}

export async function createContact(input: ContactInput): Promise<Result<Contact>> {
  try {
    const ctx = await writeContext();
    return { ok: true, value: await contactStore(prisma, ctx).create(input) };
  } catch (e) {
    return failure(e);
  }
}

export async function updateContact(id: string, input: ContactInput): Promise<Result<Contact>> {
  try {
    const ctx = await writeContext();
    return { ok: true, value: await contactStore(prisma, ctx).update(String(id), input) };
  } catch (e) {
    return failure(e);
  }
}

export async function setContactArchived(id: string, archived: boolean): Promise<Result<Contact>> {
  try {
    const ctx = await writeContext();
    const store = contactStore(prisma, ctx);
    return { ok: true, value: archived ? await store.archive(String(id)) : await store.restore(String(id)) };
  } catch (e) {
    return failure(e);
  }
}

/** Answer the section 19 question (and optionally set the host-name threshold) for the active workspace. */
export async function saveMealTaxSettings(input: TaxSettingsInput): Promise<Result<MealTaxSettings>> {
  try {
    if (typeof input?.smallBusiness !== 'boolean') return { ok: false, error: 'invalid_input' };
    const ctx = await writeContext();
    return { ok: true, value: await saveTaxSettings(prisma, ctx, input) };
  } catch (e) {
    if (e instanceof TaxSettingsError) return { ok: false, error: 'invalid_input', detail: 'invalid_threshold' };
    return failure(e);
  }
}
