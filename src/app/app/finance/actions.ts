'use server';

import { auth } from '@/lib/auth';
import { ReceiptsAuthError, requireReceiptsSession } from '@/lib/auth-guards';
import { MissingTenantError, requireSessionTenantId, sessionWorkspaceId } from '@/lib/auth-workspace';
import { prisma } from '@/lib/prisma';
import {
  PaymentServiceError,
  createAccount,
  deleteImportBatch,
  importPayments,
  linkPayment,
  setCounterpartyTreatment,
  setPaymentKind,
  unlinkPayment,
  type ImportResult,
} from '@/lib/tax/payments/service';
import { PaymentParseError } from '@/lib/tax/payments/types';
import { RULE_YEARS } from '@/lib/tax/rules';
import {
  AssetInputError,
  LinesInputError,
  RevenueInputError,
  TaxServiceError,
  TreatmentError,
  clearItemDecision,
  declineOpenYearBoundary,
  saveYearBoundaryAnswer,
  clearReceiptLines,
  createAsset,
  decideForVendor,
  deleteAsset,
  deleteInvoice,
  deleteStatusChange,
  deleteVatSettlement,
  deleteVendorRule,
  loadStatement,
  saveInvoice,
  saveItemDecision,
  saveLineDecision,
  saveReceiptLines,
  saveRevenueExpectation,
  saveStatusChange,
  saveVatSettings,
  saveVatSettlement,
  setAssetDisposal,
  updateAsset,
  isWorkspaceReceipt,
  type StatementView,
  type TaxContext,
} from '@/lib/tax/service';

/**
 * Server actions of the finance area.
 *
 * Every action re-resolves the verified session; the workspace is the
 * session's ACTIVE one and is never taken from the browser. Writes pass the
 * fail-closed `receipts.row.write` check. Failures are RETURNED with a stable
 * code (see the meal actions for why), and every write answers with the
 * freshly computed statement, so the screen never shows a figure that was
 * worked out in the browser.
 */

export type FinanceActionError =
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'invalid_input'
  | 'not_initialized'
  | 'failed';

export type Result<T> = { ok: true; value: T } | { ok: false; error: FinanceActionError; detail?: string };

function failure(e: unknown): { ok: false; error: FinanceActionError; detail?: string } {
  if (e instanceof ReceiptsAuthError) {
    return { ok: false, error: e.status === 401 ? 'unauthorized' : e.status === 404 ? 'not_found' : 'forbidden' };
  }
  const status = (e as { status?: number })?.status;
  if (status === 401) return { ok: false, error: 'unauthorized' };
  if (status === 403) return { ok: false, error: 'forbidden' };
  if (e instanceof MissingTenantError) return { ok: false, error: 'forbidden' };
  if (e instanceof TreatmentError) return { ok: false, error: 'invalid_input', detail: e.code };
  if (e instanceof AssetInputError) return { ok: false, error: 'invalid_input', detail: e.code };
  if (e instanceof RevenueInputError) return { ok: false, error: 'invalid_input', detail: e.code };
  if (e instanceof LinesInputError) return { ok: false, error: 'invalid_input', detail: e.code };
  if (e instanceof PaymentParseError) return { ok: false, error: 'invalid_input', detail: e.row === null ? e.code : `${e.code}:${e.row}` };
  if (e instanceof PaymentServiceError) {
    const missing = ['account_not_found', 'batch_not_found', 'payment_not_found', 'link_not_found', 'target_not_found'];
    return { ok: false, error: missing.includes(e.code) ? 'not_found' : 'invalid_input', detail: e.code };
  }
  if (e instanceof TaxServiceError) {
    if (
      e.code === 'row_not_found' ||
      e.code === 'rule_not_found' ||
      e.code === 'asset_not_found' ||
      e.code === 'invoice_not_found' ||
      e.code === 'status_not_found' ||
      e.code === 'settlement_not_found' ||
      e.code === 'line_not_found' ||
      e.code === 'boundary_subject_not_found'
    ) {
      return { ok: false, error: 'not_found', detail: e.code };
    }
    if (e.code === 'not_initialized') return { ok: false, error: 'not_initialized' };
    return { ok: false, error: 'invalid_input', detail: e.code };
  }
  console.error('[finance] action failed', e);
  return { ok: false, error: 'failed' };
}

/** A year a person can sensibly ask for; anything else falls back to the current year. */
function safeYear(year: unknown): number {
  const n = typeof year === 'number' ? year : Number(year);
  const current = new Date().getFullYear();
  const oldest = Math.min(...RULE_YEARS) - 10;
  return Number.isInteger(n) && n >= oldest && n <= current + 1 ? n : current;
}

async function writeContext(): Promise<TaxContext> {
  const session = await auth.requireAction('receipts.row.write');
  const workspaceId = sessionWorkspaceId(session);
  return { workspaceId, tenantId: requireSessionTenantId(session, workspaceId) };
}

export async function getStatement(year: number): Promise<Result<StatementView>> {
  try {
    const session = await requireReceiptsSession();
    return { ok: true, value: await loadStatement(prisma, sessionWorkspaceId(session), safeYear(year)) };
  } catch (e) {
    return failure(e);
  }
}

export interface DecisionRequest {
  rowId: string;
  treatment: unknown;
  /** Also make this the vendor's treatment. */
  applyToVendor?: { vendor: string; effectiveFrom?: string };
}

/**
 * Decide one receipt, or its whole vendor. With `applyToVendor` the treatment
 * becomes the vendor rule; the receipt then follows the rule, or keeps the
 * decision as its own when the rule starts after the receipt's date (see
 * `decideForVendor`).
 */
export async function decideItem(year: number, request: DecisionRequest): Promise<Result<StatementView>> {
  try {
    const ctx = await writeContext();
    const rowId = String(request?.rowId ?? '');
    if (request?.applyToVendor) {
      await decideForVendor(prisma, ctx, rowId, {
        vendor: String(request.applyToVendor.vendor ?? ''),
        effectiveFrom: request.applyToVendor.effectiveFrom,
        treatment: request.treatment,
      });
    } else {
      await saveItemDecision(prisma, ctx, rowId, request?.treatment);
    }
    return { ok: true, value: await loadStatement(prisma, ctx.workspaceId, safeYear(year)) };
  } catch (e) {
    return failure(e);
  }
}

export async function resetItem(year: number, rowId: string): Promise<Result<StatementView>> {
  try {
    const ctx = await writeContext();
    await clearItemDecision(prisma, ctx, String(rowId));
    return { ok: true, value: await loadStatement(prisma, ctx.workspaceId, safeYear(year)) };
  } catch (e) {
    return failure(e);
  }
}

export async function removeVendorRule(year: number, ruleId: string): Promise<Result<StatementView>> {
  try {
    const ctx = await writeContext();
    await deleteVendorRule(prisma, ctx, String(ruleId));
    return { ok: true, value: await loadStatement(prisma, ctx.workspaceId, safeYear(year)) };
  } catch (e) {
    return failure(e);
  }
}

/** Create an asset (`assetId` null) or change one. The body is checked on the server; see `validateAssetInput`. */
export async function saveAsset(year: number, assetId: string | null, input: unknown): Promise<Result<StatementView>> {
  try {
    const ctx = await writeContext();
    if (assetId === null) await createAsset(prisma, ctx, input);
    else await updateAsset(prisma, ctx, String(assetId), input);
    return { ok: true, value: await loadStatement(prisma, ctx.workspaceId, safeYear(year)) };
  } catch (e) {
    return failure(e);
  }
}

export async function removeAsset(year: number, assetId: string): Promise<Result<StatementView>> {
  try {
    const ctx = await writeContext();
    await deleteAsset(prisma, ctx, String(assetId));
    return { ok: true, value: await loadStatement(prisma, ctx.workspaceId, safeYear(year)) };
  } catch (e) {
    return failure(e);
  }
}

/** Record that an asset left the register; `disposal` null takes that back. */
export async function disposeAsset(year: number, assetId: string, disposal: unknown | null): Promise<Result<StatementView>> {
  try {
    const ctx = await writeContext();
    await setAssetDisposal(prisma, ctx, String(assetId), disposal);
    return { ok: true, value: await loadStatement(prisma, ctx.workspaceId, safeYear(year)) };
  } catch (e) {
    return failure(e);
  }
}

/** Run one write for the active workspace and answer with the freshly computed statement. */
async function write(year: number, run: (ctx: TaxContext) => Promise<unknown>): Promise<Result<StatementView>> {
  try {
    const ctx = await writeContext();
    await run(ctx);
    return { ok: true, value: await loadStatement(prisma, ctx.workspaceId, safeYear(year)) };
  } catch (e) {
    return failure(e);
  }
}

/** Record an issued invoice (`invoiceId` null) or change one; the body is checked by `validateInvoiceInput`. */
export async function saveIssuedInvoice(year: number, invoiceId: string | null, input: unknown): Promise<Result<StatementView>> {
  return write(year, (ctx) => saveInvoice(prisma, ctx, invoiceId === null ? null : String(invoiceId), input));
}

export async function removeIssuedInvoice(year: number, invoiceId: string): Promise<Result<StatementView>> {
  return write(year, (ctx) => deleteInvoice(prisma, ctx, String(invoiceId)));
}

/** Record that the small-business status changes from a day on. */
export async function recordStatusChange(year: number, input: unknown): Promise<Result<StatementView>> {
  return write(year, (ctx) => saveStatusChange(prisma, ctx, input));
}

export async function removeStatusChange(year: number, changeId: string): Promise<Result<StatementView>> {
  return write(year, (ctx) => deleteStatusChange(prisma, ctx, String(changeId)));
}

export async function setVatSettings(year: number, input: unknown): Promise<Result<StatementView>> {
  return write(year, (ctx) => saveVatSettings(prisma, ctx, input));
}

export async function setRevenueExpectation(year: number, cents: unknown): Promise<Result<StatementView>> {
  return write(year, (ctx) => saveRevenueExpectation(prisma, ctx, cents));
}

export async function recordVatSettlement(year: number, input: unknown): Promise<Result<StatementView>> {
  return write(year, (ctx) => saveVatSettlement(prisma, ctx, input));
}

export async function removeVatSettlement(year: number, settlementId: string): Promise<Result<StatementView>> {
  return write(year, (ctx) => deleteVatSettlement(prisma, ctx, String(settlementId)));
}

export async function addAccount(year: number, input: unknown): Promise<Result<StatementView>> {
  return write(year, (ctx) => createAccount(prisma, ctx, input));
}

/**
 * Import one export file into an account. The file's text travels in the
 * request; it is parsed whole on the server before anything is stored.
 */
export async function importPaymentFile(year: number, accountId: string, text: string): Promise<Result<{ view: StatementView; imported: ImportResult }>> {
  try {
    const ctx = await writeContext();
    const imported = await importPayments(prisma, ctx, String(accountId), String(text ?? ''));
    return { ok: true, value: { view: await loadStatement(prisma, ctx.workspaceId, safeYear(year)), imported } };
  } catch (e) {
    return failure(e);
  }
}

export async function undoImport(year: number, batchId: string): Promise<Result<StatementView>> {
  return write(year, (ctx) => deleteImportBatch(prisma, ctx, String(batchId)));
}

export async function treatCounterparty(year: number, input: unknown): Promise<Result<StatementView>> {
  return write(year, (ctx) => setCounterpartyTreatment(prisma, ctx, input));
}

export async function correctPaymentKind(year: number, paymentId: string, kind: unknown): Promise<Result<StatementView>> {
  return write(year, (ctx) => setPaymentKind(prisma, ctx, String(paymentId), kind));
}

export async function confirmPaymentLink(year: number, input: unknown): Promise<Result<StatementView>> {
  return write(year, (ctx) => linkPayment(prisma, ctx, input, (rowId) => isWorkspaceReceipt(prisma, ctx.workspaceId, rowId)));
}

export async function removePaymentLink(year: number, linkId: string): Promise<Result<StatementView>> {
  return write(year, (ctx) => unlinkPayment(prisma, ctx, String(linkId)));
}

/** Split a receipt into lines, or change its split; checked by `validateLines` against the receipt's total. */
export async function saveLines(year: number, rowId: string, lines: unknown): Promise<Result<StatementView>> {
  return write(year, (ctx) => saveReceiptLines(prisma, ctx, String(rowId), lines));
}

export async function removeLines(year: number, rowId: string): Promise<Result<StatementView>> {
  return write(year, (ctx) => clearReceiptLines(prisma, ctx, String(rowId)));
}

/** Decide one line of a split receipt; `treatment` null lets it follow its receipt again. */
export async function decideLine(year: number, lineId: string, treatment: unknown | null): Promise<Result<StatementView>> {
  return write(year, (ctx) => saveLineDecision(prisma, ctx, String(lineId), treatment));
}

/** Answer the ten-day rule for one payment at the turn of the year; checked by `saveYearBoundaryAnswer`. */
export async function answerYearBoundary(year: number, input: unknown): Promise<Result<StatementView>> {
  return write(year, (ctx) => saveYearBoundaryAnswer(prisma, ctx, input));
}

/** Every payment at the turn of this year that has no answer yet stays in the year it was paid. */
export async function declineYearBoundary(year: number): Promise<Result<StatementView>> {
  return write(year, (ctx) => declineOpenYearBoundary(prisma, ctx, safeYear(year)));
}
