import 'server-only';
import { createHash } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import { vendorKey } from '../decisions';
import { proposeMatches, unambiguousReferenceMatches, type MatchProposal } from './match';
import { parsePaymentFile } from './parse';
import { PAYMENT_KINDS, type PaymentFormat, type PaymentKind } from './types';

/**
 * Server-side reads and writes for payments. Like the other finance services,
 * every function takes the workspace explicitly and addresses rows only inside
 * it. Imports are idempotent: the same file is refused, an overlapping file
 * adds only what is new.
 */

export interface PaymentContext {
  workspaceId: string;
  tenantId: string | null;
}

export type PaymentServiceErrorCode =
  | 'account_not_found'
  | 'account_label_required'
  | 'account_label_taken'
  | 'invalid_account_kind'
  | 'file_already_imported'
  | 'format_mismatch'
  | 'batch_has_later_overlap'
  | 'batch_not_found'
  | 'payment_not_found'
  | 'link_not_found'
  | 'invalid_treatment'
  | 'invalid_kind'
  | 'invalid_link'
  | 'link_exceeds_payment'
  | 'target_not_found'
  | 'target_fully_paid';

export class PaymentServiceError extends Error {
  readonly code: PaymentServiceErrorCode;
  constructor(code: PaymentServiceErrorCode) {
    super(code);
    this.name = 'PaymentServiceError';
    this.code = code;
  }
}

export type AccountKind = 'bank' | 'card' | 'payment_service';
export const ACCOUNT_KINDS: readonly AccountKind[] = ['bank', 'card', 'payment_service'];
export type CounterpartyTreatment = 'business' | 'private' | 'own_account';
export const COUNTERPARTY_TREATMENTS: readonly CounterpartyTreatment[] = ['business', 'private', 'own_account'];

/** The key a counterparty is recognized by; payments without a name share one key per account kind of text. */
export function counterpartyKey(name: string): string {
  return vendorKey(name) ?? '';
}

export async function createAccount(db: PrismaClient, ctx: PaymentContext, raw: unknown): Promise<string> {
  const input = (raw ?? {}) as { label?: unknown; kind?: unknown };
  const label = typeof input.label === 'string' ? input.label.trim() : '';
  if (!label || label.length > 80) throw new PaymentServiceError('account_label_required');
  if (typeof input.kind !== 'string' || !(ACCOUNT_KINDS as readonly string[]).includes(input.kind)) throw new PaymentServiceError('invalid_account_kind');
  const taken = await db.taxAccount.findFirst({ where: { authWorkspaceId: ctx.workspaceId, label } });
  if (taken) throw new PaymentServiceError('account_label_taken');
  const account = await db.taxAccount.create({ data: { authWorkspaceId: ctx.workspaceId, authTenantId: ctx.tenantId, label, kind: input.kind } });
  return account.id;
}

export interface ImportResult {
  batchId: string;
  format: PaymentFormat;
  /** Payments in the file, how many of them are new, and how many were already there. */
  total: number;
  added: number;
  alreadyThere: number;
  /** Rows of the file left out on purpose (pending, other currency, memo lines), by reason. */
  skipped: Record<string, number>;
  /** Payments linked to an issued invoice because its number is in the payment's text. */
  autoLinked: number;
  firstDay: string | null;
  lastDay: string | null;
}

/**
 * Import one export file into one account. The file is parsed whole before
 * anything is written (a `PaymentParseError` leaves the database untouched),
 * and batch and payments are written together or not at all.
 */
export async function importPayments(db: PrismaClient, ctx: PaymentContext, accountId: string, text: string): Promise<ImportResult> {
  const account = await db.taxAccount.findFirst({ where: { id: accountId, authWorkspaceId: ctx.workspaceId } });
  if (!account) throw new PaymentServiceError('account_not_found');
  const contentHash = createHash('sha256').update(text).digest('hex');
  if (await db.taxImportBatch.findFirst({ where: { accountId, contentHash } })) throw new PaymentServiceError('file_already_imported');

  const parsed = parsePaymentFile(text);
  // One account, one source: the identity of a movement is built from the text
  // of its source, so the same account imported once as a bank export and once
  // through the bank interface would hold every movement twice.
  const earlier = await db.taxImportBatch.findFirst({ where: { accountId } });
  if (earlier && earlier.format !== parsed.format) throw new PaymentServiceError('format_mismatch');

  // Everything from here on happens together or not at all, including the
  // automatic links: a failure leaves no batch behind that would refuse a retry.
  const { batch, added, autoLinked } = await db.$transaction(async (tx) => {
    const existing = new Set(
      (await tx.taxPayment.findMany({ where: { accountId, sourceHash: { in: parsed.payments.map((p) => p.sourceHash) } }, select: { sourceHash: true } })).map((p) => p.sourceHash),
    );
    const fresh = parsed.payments.filter((p) => !existing.has(p.sourceHash));
    const created = await tx.taxImportBatch.create({
      data: {
        authWorkspaceId: ctx.workspaceId,
        authTenantId: ctx.tenantId,
        accountId,
        contentHash,
        format: parsed.format,
        paymentCount: parsed.payments.length,
        newCount: fresh.length,
        firstDay: parsed.firstDay,
        lastDay: parsed.lastDay,
      },
    });
    let inserted = 0;
    if (fresh.length > 0) {
      const result = await tx.taxPayment.createMany({
        // A second import running at the same moment may have stored some of
        // these already; they are skipped, not an error.
        skipDuplicates: true,
        data: fresh.map((p) => ({
          authWorkspaceId: ctx.workspaceId,
          authTenantId: ctx.tenantId,
          accountId,
          batchId: created.id,
          bookingDay: p.bookingDay,
          valueDay: p.valueDay,
          amountCents: p.amountCents,
          counterparty: p.counterparty,
          counterpartyKey: counterpartyKey(p.counterparty),
          reference: p.reference,
          entryReference: p.entryReference,
          sourceKind: p.kind,
          sourceHash: p.sourceHash,
        })),
      });
      inserted = result.count;
      if (inserted !== fresh.length) await tx.taxImportBatch.update({ where: { id: created.id }, data: { newCount: inserted } });
    }
    return { batch: created, added: inserted, autoLinked: await linkByReference(tx, ctx, created.id) };
    // A year of payments on a busy server takes longer than the five seconds a transaction gets by default.
  }, { maxWait: 20_000, timeout: 120_000 });

  return {
    batchId: batch.id,
    format: parsed.format,
    total: parsed.payments.length,
    added,
    alreadyThere: parsed.payments.length - added,
    skipped: parsed.skipped,
    autoLinked,
    firstDay: parsed.firstDay,
    lastDay: parsed.lastDay,
  };
}

/**
 * Link the batch's incoming payments to issued invoices where the invoice
 * number is in the payment's text, the amount is exactly what is open, and
 * neither side could mean another. Everything else waits for a person.
 */
async function linkByReference(db: Prisma.TransactionClient, ctx: PaymentContext, batchId: string): Promise<number> {
  // Whether a link is unambiguous is judged against every unlinked incoming
  // payment of the workspace, not only this file's: an earlier payment naming
  // the same invoice makes the new one ambiguous too.
  const payments = await db.taxPayment.findMany({ where: { authWorkspaceId: ctx.workspaceId, amountCents: { gt: 0 } }, include: { links: true } });
  const invoices = await db.taxIssuedInvoice.findMany({ where: { authWorkspaceId: ctx.workspaceId }, include: { payments: true, paymentLinks: true } });
  const proposals = unambiguousReferenceMatches(
    proposeMatches(
      payments.filter((p) => p.links.length === 0 && effectiveKind(p) === 'income').map((p) => ({ id: p.id, bookingDay: p.bookingDay, amountCents: p.amountCents, reference: p.reference, counterparty: p.counterparty })),
      invoices.map((i) => ({ id: i.id, number: i.number, day: i.issueDate, openCents: invoiceOpenCents(i) })),
    ),
  ).filter((proposal) => payments.find((p) => p.id === proposal.paymentId)?.batchId === batchId);
  for (const proposal of proposals) {
    const payment = payments.find((p) => p.id === proposal.paymentId)!;
    await db.taxPaymentLink.create({
      data: { authWorkspaceId: ctx.workspaceId, authTenantId: ctx.tenantId, paymentId: payment.id, invoiceId: proposal.documentId, cents: payment.amountCents, method: 'reference' },
    });
  }
  return proposals.length;
}

function invoiceOpenCents(invoice: { grossCents: number; payments: Array<{ cents: number }>; paymentLinks: Array<{ cents: number }> }): number {
  const paid = invoice.payments.reduce((s, p) => s + p.cents, 0) + invoice.paymentLinks.reduce((s, l) => s + l.cents, 0);
  return Math.max(0, invoice.grossCents - paid);
}

export function effectiveKind(payment: { sourceKind: string; kindOverride: string | null }): PaymentKind {
  const kind = payment.kindOverride ?? payment.sourceKind;
  return (PAYMENT_KINDS as readonly string[]).includes(kind) ? (kind as PaymentKind) : 'spend';
}

/** Undo an import: the batch goes, with the payments it added and their links. */
export async function deleteImportBatch(db: PrismaClient, ctx: PaymentContext, batchId: string): Promise<void> {
  const batch = await db.taxImportBatch.findFirst({ where: { id: batchId, authWorkspaceId: ctx.workspaceId } });
  if (!batch) throw new PaymentServiceError('batch_not_found');
  // A payment belongs to the file that brought it first. A later file covering
  // the same days relied on those payments being there, so undoing this import
  // would silently take days out of that later file. Imports are undone newest first.
  if (batch.firstDay !== null && batch.lastDay !== null) {
    const later = await db.taxImportBatch.findFirst({
      where: { accountId: batch.accountId, createdAt: { gt: batch.createdAt }, firstDay: { lte: batch.lastDay }, lastDay: { gte: batch.firstDay } },
    });
    if (later) throw new PaymentServiceError('batch_has_later_overlap');
  }
  await db.taxImportBatch.deleteMany({ where: { id: batchId, authWorkspaceId: ctx.workspaceId } });
}

/** Say once how a counterparty is treated; `null` takes the answer back. */
export async function setCounterpartyTreatment(db: PrismaClient, ctx: PaymentContext, raw: unknown): Promise<void> {
  const input = (raw ?? {}) as { counterparty?: unknown; treatment?: unknown };
  const label = typeof input.counterparty === 'string' ? input.counterparty.trim() : '';
  const key = counterpartyKey(label);
  if (!key) throw new PaymentServiceError('invalid_treatment');
  if (input.treatment === null) {
    await db.taxCounterpartyRule.deleteMany({ where: { authWorkspaceId: ctx.workspaceId, counterpartyKey: key } });
    return;
  }
  if (typeof input.treatment !== 'string' || !(COUNTERPARTY_TREATMENTS as readonly string[]).includes(input.treatment)) {
    throw new PaymentServiceError('invalid_treatment');
  }
  await db.taxCounterpartyRule.upsert({
    where: { authWorkspaceId_counterpartyKey: { authWorkspaceId: ctx.workspaceId, counterpartyKey: key } },
    create: { authWorkspaceId: ctx.workspaceId, authTenantId: ctx.tenantId, counterpartyKey: key, label, treatment: input.treatment },
    update: { treatment: input.treatment, label },
  });
}

/** Correct what one payment is (for example a refund the file called income); `null` returns to what the file says. */
export async function setPaymentKind(db: PrismaClient, ctx: PaymentContext, paymentId: string, kind: unknown): Promise<void> {
  if (kind !== null && (typeof kind !== 'string' || !(PAYMENT_KINDS as readonly string[]).includes(kind))) throw new PaymentServiceError('invalid_kind');
  const { count } = await db.taxPayment.updateMany({ where: { id: paymentId, authWorkspaceId: ctx.workspaceId }, data: { kindOverride: kind as string | null } });
  if (count === 0) throw new PaymentServiceError('payment_not_found');
}

export interface LinkInput {
  paymentId: string;
  /** Exactly one of the two. */
  rowId?: string | null;
  invoiceId?: string | null;
  /** The part of the payment that belongs to the target; omitted: all that is not linked yet. */
  cents?: number | null;
}

/**
 * Link a payment (or part of it) to a receipt or an issued invoice, by a
 * person's confirmation. `rowBelongsToWorkspace` is how the caller proves a
 * receipt row is this workspace's (rows live in the generic table).
 */
export async function linkPayment(
  db: PrismaClient,
  ctx: PaymentContext,
  raw: unknown,
  rowBelongsToWorkspace: (rowId: string) => Promise<boolean>,
): Promise<string> {
  const input = (raw ?? {}) as LinkInput;
  const rowId = typeof input.rowId === 'string' && input.rowId ? input.rowId : null;
  const invoiceId = typeof input.invoiceId === 'string' && input.invoiceId ? input.invoiceId : null;
  if (typeof input.paymentId !== 'string' || (rowId === null) === (invoiceId === null)) throw new PaymentServiceError('invalid_link');
  if (rowId !== null && !(await rowBelongsToWorkspace(rowId))) throw new PaymentServiceError('target_not_found');

  return db.$transaction(async (tx) => {
    // Lock the payment so two confirmations at the same moment cannot both use its free amount.
    await tx.$queryRaw`SELECT id FROM tax_payments WHERE id = ${input.paymentId} AND auth_workspace_id = ${ctx.workspaceId} FOR UPDATE`;
    const payment = await tx.taxPayment.findFirst({ where: { id: input.paymentId, authWorkspaceId: ctx.workspaceId }, include: { links: true } });
    if (!payment) throw new PaymentServiceError('payment_not_found');
    let free = Math.abs(payment.amountCents) - payment.links.reduce((s, l) => s + l.cents, 0);
    if (invoiceId !== null) {
      const invoice = await tx.taxIssuedInvoice.findFirst({ where: { id: invoiceId, authWorkspaceId: ctx.workspaceId }, include: { payments: true, paymentLinks: true } });
      if (!invoice) throw new PaymentServiceError('target_not_found');
      // Only money received pays an invoice.
      if (payment.amountCents <= 0) throw new PaymentServiceError('invalid_link');
      // Never more than the invoice still has open: what was typed in by hand
      // and what other payments already cover is not counted a second time.
      const open = invoiceOpenCents(invoice);
      if (open <= 0) throw new PaymentServiceError('target_fully_paid');
      free = Math.min(free, open);
    }
    const cents = input.cents === undefined || input.cents === null ? free : input.cents;
    if (!Number.isInteger(cents) || cents <= 0) throw new PaymentServiceError('invalid_link');
    if (cents > free) throw new PaymentServiceError('link_exceeds_payment');
    const link = await tx.taxPaymentLink.create({
      data: { authWorkspaceId: ctx.workspaceId, authTenantId: ctx.tenantId, paymentId: payment.id, rowId, invoiceId, cents, method: 'manual' },
    });
    return link.id;
  });
}

export async function unlinkPayment(db: PrismaClient, ctx: PaymentContext, linkId: string): Promise<void> {
  const { count } = await db.taxPaymentLink.deleteMany({ where: { id: linkId, authWorkspaceId: ctx.workspaceId } });
  if (count === 0) throw new PaymentServiceError('link_not_found');
}

/** Called by the row delete paths: a deleted receipt takes its payment links with it; the payments stay. */
export async function deletePaymentLinksForRows(db: PrismaClient, rowIds: string[]): Promise<void> {
  if (rowIds.length === 0) return;
  await db.taxPaymentLink.deleteMany({ where: { rowId: { in: rowIds } } });
}

// ── Reading ──────────────────────────────────────────────────────────────────

export interface PaymentRow {
  id: string;
  accountId: string;
  bookingDay: string;
  amountCents: number;
  counterparty: string;
  counterpartyKey: string;
  reference: string;
  kind: PaymentKind;
  kindOverridden: boolean;
  links: Array<{ id: string; rowId: string | null; invoiceId: string | null; cents: number; method: string }>;
}

export interface LoadedPayments {
  accounts: Array<{ id: string; label: string; kind: string; paymentCount: number; completeThrough: string | null; batches: Array<{ id: string; format: string; newCount: number; paymentCount: number; firstDay: string | null; lastDay: string | null; importedAt: string }> }>;
  payments: PaymentRow[];
  treatments: Map<string, CounterpartyTreatment>;
}

/** Every payment of the workspace with its links, and what was said about the counterparties. */
export async function loadPayments(db: PrismaClient, workspaceId: string): Promise<LoadedPayments> {
  const [accounts, payments, rules] = await Promise.all([
    db.taxAccount.findMany({ where: { authWorkspaceId: workspaceId }, include: { batches: { orderBy: { createdAt: 'desc' } } }, orderBy: { label: 'asc' } }),
    db.taxPayment.findMany({ where: { authWorkspaceId: workspaceId }, include: { links: true }, orderBy: [{ bookingDay: 'asc' }, { createdAt: 'asc' }] }),
    db.taxCounterpartyRule.findMany({ where: { authWorkspaceId: workspaceId } }),
  ]);
  const treatments = new Map<string, CounterpartyTreatment>();
  for (const rule of rules) {
    if ((COUNTERPARTY_TREATMENTS as readonly string[]).includes(rule.treatment)) treatments.set(rule.counterpartyKey, rule.treatment as CounterpartyTreatment);
  }
  const rows: PaymentRow[] = payments.map((p) => ({
    id: p.id,
    accountId: p.accountId,
    bookingDay: p.bookingDay,
    amountCents: p.amountCents,
    counterparty: p.counterparty,
    counterpartyKey: p.counterpartyKey,
    reference: p.reference,
    // Moving money to an own account is no spend, whatever the file calls it.
    kind: treatments.get(p.counterpartyKey) === 'own_account' ? 'own_transfer' : effectiveKind(p),
    kindOverridden: p.kindOverride !== null,
    links: p.links.map((l) => ({ id: l.id, rowId: l.rowId, invoiceId: l.invoiceId, cents: l.cents, method: l.method })),
  }));
  return {
    accounts: accounts.map((a) => {
      const own = rows.filter((r) => r.accountId === a.id);
      return {
        id: a.id,
        label: a.label,
        kind: a.kind,
        paymentCount: own.length,
        // The last booked day the account has data for: how fresh this source is.
        completeThrough: own.length > 0 ? own[own.length - 1].bookingDay : null,
        batches: a.batches.map((b) => ({ id: b.id, format: b.format, newCount: b.newCount, paymentCount: b.paymentCount, firstDay: b.firstDay, lastDay: b.lastDay, importedAt: b.createdAt.toISOString() })),
      };
    }),
    payments: rows,
    treatments,
  };
}

export type { MatchProposal };
