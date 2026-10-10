'use server';

import type { AppSession } from '@marlinjai/auth-brain-nextjs';
import { auth } from '@/lib/auth';
import { ReceiptsAuthError, requireReceiptsSession, requireRowAccess } from '@/lib/auth-guards';
import { MissingTenantError, requireSessionTenantId, sessionWorkspaceId } from '@/lib/auth-workspace';
import { companyContacts } from '@/lib/contacts/db';
import { countDirectoryOrganizations } from '@/lib/contacts/directory';
import { ContactError, type Contact, type ContactInput } from '@/lib/contacts/store';
import { normalizeRowIds, type MealBatchResult } from '@/lib/meals/batch';
import { MealInputError, type MealDetailsInput } from '@/lib/meals/input';
import {
  MealServiceError,
  contactStore,
  deleteReceiptRows,
  getTaxSettings,
  TaxSettingsError,
  lastUsedHost,
  loadLastUsedHost,
  loadMealRecord,
  loadMealRecords,
  saveMealDetails,
  saveTaxSettings,
  setMealTypeForRows,
  setReceiptFileRotation,
  type MealContext,
  type TaxSettingsInput,
} from '@/lib/meals/service';
import type { MealRecord, MealTaxSettings } from '@/lib/meals/types';
import { parseRotation } from '@/lib/meals/viewer-state';
import { prisma } from '@/lib/prisma';
import { deleteStoredFile } from '@/lib/stored-files';

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
  | 'contact_stale'
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
    if (e.code === 'stale') return { ok: false, error: 'contact_stale' };
    return { ok: false, error: 'contact_invalid', detail: e.code };
  }
  if (e instanceof MealServiceError) {
    if (e.code === 'row_not_found' || e.code === 'unknown_contact') return { ok: false, error: 'not_found', detail: e.code };
    if (e.code === 'archived_contact') return { ok: false, error: 'contact_archived' };
    if (e.code === 'invalid_rotation') return { ok: false, error: 'invalid_input', detail: e.code };
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

/** The company a contact read is scoped to. Fails closed like the writes do. */
function contactReadTenant(session: AppSession, workspaceId: string): string | null {
  return requireSessionTenantId(session, workspaceId);
}

async function writeContext(): Promise<MealContext> {
  const session = await auth.requireAction('receipts.row.write');
  const workspaceId = sessionWorkspaceId(session);
  return { workspaceId, tenantId: requireSessionTenantId(session, workspaceId) };
}

export interface MealsPageData {
  /** Register entries, incomplete meals, separately counted meals, and the receipts marked "Keine Bewirtung". */
  records: MealRecord[];
  contacts: Contact[];
  /**
   * Organizations among the company's contacts. The contacts page lists them next
   * to the persons, so the count on the link to it covers both; the guest picker
   * offers persons only.
   * Zero while the shared contact database is off.
   */
  organizationCount: number;
  settings: MealTaxSettings;
  /** The host name used most recently, to prefill a new entry. */
  defaultHost: string;
}

export async function getMealsPageData(): Promise<Result<MealsPageData>> {
  try {
    const session = await requireReceiptsSession();
    const workspaceId = readContext(session);
    const tenantId = contactReadTenant(session, workspaceId);
    const [records, contacts, settings, organizationCount] = await Promise.all([
      loadMealRecords(prisma, workspaceId, { includeDismissed: true }),
      contactStore(prisma, { workspaceId, tenantId }).list({ includeArchived: true }),
      getTaxSettings(prisma, workspaceId),
      tenantId ? countDirectoryOrganizations(companyContacts(tenantId)) : Promise.resolve(0),
    ]);
    return { ok: true, value: { records, contacts, organizationCount, settings, defaultHost: lastUsedHost(records) } };
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
    const tenantId = contactReadTenant(session, workspaceId);
    const [contacts, settings, defaultHost] = await Promise.all([
      contactStore(prisma, { workspaceId, tenantId }).list({ includeArchived: true }),
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

/**
 * The three list actions. Each takes row ids from the browser, cleans them,
 * and works only inside the ACTIVE workspace's Receipts table: an id of
 * another workspace is reported back as skipped, never touched. One receipt
 * that cannot be handled does not stop the others; the result names each.
 */
async function runBatch(
  rawRowIds: unknown,
  run: (ctx: MealContext, rowIds: string[]) => Promise<MealBatchResult>,
): Promise<Result<MealBatchResult>> {
  try {
    const rowIds = normalizeRowIds(rawRowIds);
    if (!rowIds) return { ok: false, error: 'invalid_input', detail: 'row_ids' };
    const ctx = await writeContext();
    return { ok: true, value: await run(ctx, rowIds) };
  } catch (e) {
    return failure(e);
  }
}

/** "Keine Bewirtung" for several receipts: the same state the form's option sets, details kept. */
export async function markMealsNotMeal(rowIds: string[]): Promise<Result<MealBatchResult>> {
  return runBatch(rowIds, (ctx, ids) => setMealTypeForRows(prisma, ctx, ids, 'not_a_meal'));
}

/** Take receipts marked "Keine Bewirtung" back as business meals, with the details they had. */
export async function restoreMeals(rowIds: string[]): Promise<Result<MealBatchResult>> {
  return runBatch(rowIds, (ctx, ids) => setMealTypeForRows(prisma, ctx, ids, 'business_meal_external'));
}

/** Delete receipts for good: stored file, row and meal guests. Cannot be undone. */
export async function deleteMealReceipts(rowIds: string[]): Promise<Result<MealBatchResult>> {
  return runBatch(rowIds, (ctx, ids) => deleteReceiptRows(prisma, ctx, ids, { deleteStoredFile }));
}

/**
 * Store how far a receipt file is turned (0, 90, 180 or 270 degrees
 * clockwise). View metadata on the file reference; the file is not rewritten.
 */
export async function saveReceiptRotation(
  rowId: string,
  fileRefId: string,
  rotation: number,
): Promise<Result<{ record: MealRecord }>> {
  try {
    const parsed = parseRotation(rotation);
    if (parsed === null || typeof rowId !== 'string' || typeof fileRefId !== 'string' || !rowId || !fileRefId) {
      return { ok: false, error: 'invalid_input', detail: 'rotation' };
    }
    const ctx = await writeContext();
    return { ok: true, value: { record: await setReceiptFileRotation(prisma, ctx, rowId, fileRefId, parsed) } };
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
