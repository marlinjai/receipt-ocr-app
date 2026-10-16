import 'server-only';
import { createHash } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import { vendorKey } from '../decisions';
import { resolveFunding, type Funding } from './funding';
import { proposeMatches, unambiguousReferenceMatches, type MatchProposal } from './match';
import { batchCoverage, beyondStored, covers, coveredByOtherSources, mergeIntervals, orderBatches, overlaps } from './coverage';
import { parsePaymentFile, referenceHash } from './parse';
import { amountQuery } from './search';
import { PAYMENT_KINDS, type NormalizedPayment, type PaymentFormat, type PaymentKind } from './types';

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
  /** A payment service's list and another source in one account: they hold different movements, never the same ones. */
  | 'format_mismatch'
  /** The year an import is limited to is no sensible year. */
  | 'invalid_import_year'
  /** No row of the file lies in the chosen year, and it cancels nothing. */
  | 'nothing_in_year'
  /** Every day of the file is held by another source of the account already, and it cancels nothing. */
  | 'nothing_uncovered'
  /** Limited to a year, the file adds, recognizes and cancels nothing. */
  | 'nothing_new'
  /** A later import from another source of the account relied on this one's days: undo that one first. */
  | 'batch_has_later_source'
  /** A later import cancelled purchases of this one, or this one cancelled purchases a later import may report too. */
  | 'batch_has_later_cancellation'
  | 'batch_has_later_overlap'
  | 'batch_not_found'
  | 'payment_not_found'
  | 'link_not_found'
  | 'invalid_treatment'
  | 'invalid_kind'
  | 'invalid_link'
  | 'link_exceeds_payment'
  | 'target_not_found'
  | 'target_fully_paid'
  /** The invoice's rest was booked out as never to be paid: take the write-off back first if the client paid after all. */
  | 'target_written_off'
  /** The receipt already carries payments, and this one would take it beyond its own amount: asked about, not refused. */
  | 'receipt_already_paid'
  /** The pair is no proposal any more (one side was linked in the meantime). */
  | 'proposal_gone'
  /** A search for payments without a year, or a whole-account answer that is neither yes nor no. */
  | 'invalid_query'
  | 'invalid_private';

export class PaymentServiceError extends Error {
  readonly code: PaymentServiceErrorCode;
  /** For `receipt_already_paid`: "<cents already linked>:<the receipt's own cents>". */
  readonly detail: string | null;
  constructor(code: PaymentServiceErrorCode, detail: string | null = null) {
    super(code);
    this.name = 'PaymentServiceError';
    this.code = code;
    this.detail = detail;
  }
}

export type AccountKind = 'bank' | 'card' | 'payment_service';
export const ACCOUNT_KINDS: readonly AccountKind[] = ['bank', 'card', 'payment_service'];
/**
 * How a counterparty is treated. `mixed`: some of its payments are business and
 * some are private (a marketplace, a supermarket), so none is asked about; the
 * ones a person links to a receipt by hand are the business ones.
 */
export type CounterpartyTreatment = 'business' | 'private' | 'own_account' | 'mixed';
export const COUNTERPARTY_TREATMENTS: readonly CounterpartyTreatment[] = ['business', 'private', 'own_account', 'mixed'];

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
  /**
   * Rows of the file left out on purpose (pending, other currency, memo lines),
   * by reason. Two reasons come from the import itself: `other_year` (outside
   * the year the import was limited to) and `covered_by_other_source` (on a day
   * another source of the same account already covers).
   */
  skipped: Record<string, number>;
  /** The year the import was limited to; null: every day of the file. */
  onlyYear: number | null;
  /** Payments linked to an issued invoice because its number is in the payment's text. */
  autoLinked: number;
  /** Payments of an earlier import that this file lists as cancelled or refunded in full: they stopped counting. */
  cancelledEarlier: number;
  /** Of those, how many were linked to a receipt (the link is kept and released, see the payments view). */
  releasedLinks: number;
  /** Payments stored without the source's number that this file gave one: recognized, not stored again. */
  adopted: number;
  /** Rows that were read but need a look, by reason. */
  notices: Record<string, number>;
  /** Status wordings the reader did not know; those rows were read as purchases. */
  unknownStatuses: string[];
  firstDay: string | null;
  lastDay: string | null;
}

/** The bank sources: one bank account may be continued from one of them by another (see `coverage.ts`). */
const BANK_FORMATS: readonly string[] = ['enable_banking_json', 'n26_csv', 'tomorrow_csv'] satisfies PaymentFormat[];

export interface ImportOptions {
  /** Read only the payments booked in this year; the rest of the file is counted and left out. */
  onlyYear?: number | null;
}

/** The years an import can be limited to: the same range the finance area offers. */
function validImportYear(raw: unknown): number | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 2000 || raw > 2100) throw new PaymentServiceError('invalid_import_year');
  return raw;
}

/**
 * Import one export file into one account. The file is parsed whole before
 * anything is written (a `PaymentParseError` leaves the database untouched),
 * and batch and payments are written together or not at all.
 *
 * An account can be continued from another source (a bank export that ends in
 * the middle of the year, continued from the bank interface's list). The
 * identity of a movement is built from the text of its source, so the same
 * movement from two sources would be stored twice; therefore a day belongs to
 * the source that brought it first: rows of this file on a day an import of
 * ANOTHER format of the account covers (its first to its last day) are left
 * out and counted. Days no other source covers are read as usual.
 *
 * With `onlyYear` only the payments booked in that year are read. Such an
 * import is a different import from the whole file: the whole file (or another
 * year of it) can be read later and adds only what is new.
 */
export async function importPayments(db: PrismaClient, ctx: PaymentContext, accountId: string, text: string, options: ImportOptions = {}): Promise<ImportResult> {
  const onlyYear = validImportYear(options.onlyYear);
  const account = await db.taxAccount.findFirst({ where: { id: accountId, authWorkspaceId: ctx.workspaceId } });
  if (!account) throw new PaymentServiceError('account_not_found');
  const contentHash = createHash('sha256').update(onlyYear === null ? text : `${text}\u0000only-year:${onlyYear}`).digest('hex');
  if (await db.taxImportBatch.findFirst({ where: { accountId, contentHash } })) throw new PaymentServiceError('file_already_imported');
  const file = parsePaymentFile(text);

  // Everything from here on happens together or not at all, including the
  // automatic links: a failure leaves no batch behind that would refuse a retry.
  const { batch, added, autoLinked, adopted, cancelledEarlier, releasedLinks, parsed } = await db.$transaction(async (tx) => {
    // One import per account at a time: what other sources hold is read and judged without another import slipping in.
    const locked = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM tax_accounts WHERE id = ${accountId} AND auth_workspace_id = ${ctx.workspaceId} FOR UPDATE`;
    if (locked.length === 0) throw new PaymentServiceError('account_not_found');
    if (await tx.taxImportBatch.findFirst({ where: { accountId, contentHash } })) throw new PaymentServiceError('file_already_imported');
    const batches = await tx.taxImportBatch.findMany({ where: { accountId }, select: { id: true, format: true, firstDay: true, lastDay: true, createdAt: true } });
    // A bank account may be continued from another bank source; a payment service's list holds other
    // movements than its bank (its purchases, not the bank's debits), so the two never share an account.
    if (batches.some((b) => b.format !== file.format && !(BANK_FORMATS.includes(b.format) && BANK_FORMATS.includes(file.format)))) throw new PaymentServiceError('format_mismatch');
    const otherSources = coveredByOtherSources(batches, file.format);
    const skipped = { ...file.skipped };
    const inYear = file.payments.filter((p) => onlyYear === null || p.bookingDay.startsWith(`${onlyYear}-`));
    if (inYear.length < file.payments.length) skipped.other_year = file.payments.length - inYear.length;
    // Days another source holds are its own. Only on the first and the last day of a range it holds as a whole,
    // which an export taken in the middle of a day may hold in part, what goes beyond its stored movements is new.
    // On this source's own days the same comparison runs against what another source added on such an edge day,
    // so a fuller export of a day that another source completed stores nothing twice. The identity of a row does
    // not change by leaving others out: identical movements are numbered over the whole file.
    const onCovered = inYear.filter((p) => covers(otherSources, p.bookingDay));
    const edges = new Set(mergeIntervals(otherSources).flatMap((i) => [i.from, i.to]));
    const compared = inYear.filter((p) => !covers(otherSources, p.bookingDay) || edges.has(p.bookingDay));
    const stored = compared.length === 0 ? [] : await tx.taxPayment.findMany({
      where: { accountId, bookingDay: { in: [...new Set(compared.map((p) => p.bookingDay))] }, batch: { format: { not: file.format } } },
      select: { bookingDay: true, amountCents: true },
    });
    const { same } = beyondStored(compared, stored);
    const leftOut = new Set([...onCovered.filter((p) => !edges.has(p.bookingDay)), ...same]);
    if (leftOut.size > 0) skipped.covered_by_other_source = leftOut.size;
    const kept = inYear.filter((p) => !leftOut.has(p));
    // A file that keeps nothing still counts when it cancels purchases: those apply to any year and any day.
    if (kept.length === 0 && file.payments.length > 0 && file.cancelled.length === 0) {
      throw new PaymentServiceError(inYear.length === 0 ? 'nothing_in_year' : 'nothing_uncovered');
    }
    const days = kept.map((p) => p.bookingDay).sort();
    const parsed = { ...file, payments: kept, skipped, firstDay: days[0] ?? null, lastDay: days[days.length - 1] ?? null };
    const adopted = await adoptUnreferenced(tx, accountId, parsed.payments);
    const existing = new Set(
      (await tx.taxPayment.findMany({ where: { accountId, sourceHash: { in: parsed.payments.map((p) => p.sourceHash) } }, select: { sourceHash: true } })).map((p) => p.sourceHash),
    );
    const fresh = parsed.payments.filter((p) => !existing.has(p.sourceHash));
    // After every import before it, also when they share a millisecond: the order of imports decides which source holds a day.
    const newest = batches.reduce((max, b) => Math.max(max, b.createdAt.getTime()), 0);
    const created = await tx.taxImportBatch.create({
      data: {
        createdAt: new Date(Math.max(Date.now(), newest + 1)),
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
    // A purchase an earlier file brought as paid and this one lists as cancelled or refunded in full
    // is kept and marked with this import; undoing this import clears the mark again.
    let cancelledEarlier = 0;
    let releasedLinks = 0;
    if (parsed.cancelled.length > 0) {
      const where = { accountId, sourceHash: { in: parsed.cancelled }, cancelledByBatchId: null };
      releasedLinks = await tx.taxPaymentLink.count({ where: { payment: where } });
      cancelledEarlier = (await tx.taxPayment.updateMany({ where, data: { cancelledByBatchId: created.id } })).count;
    }
    // A year of a file that adds, recognizes and cancels nothing: its empty import would only stand in the way of
    // undoing. Undone with the rest. (A whole file that brings nothing new is still recorded, as before.)
    if (onlyYear !== null && inserted === 0 && adopted === 0 && cancelledEarlier === 0) throw new PaymentServiceError('nothing_new');
    return { batch: created, added: inserted, autoLinked: await linkByReference(tx, ctx, created.id), adopted, cancelledEarlier, releasedLinks, parsed };
    // A year of payments on a busy server takes longer than the five seconds a transaction gets by default.
  }, { maxWait: 20_000, timeout: 120_000 });

  return {
    batchId: batch.id,
    format: parsed.format,
    total: parsed.payments.length,
    added,
    alreadyThere: parsed.payments.length - added,
    skipped: parsed.skipped,
    onlyYear,
    autoLinked,
    cancelledEarlier,
    releasedLinks,
    adopted,
    notices: parsed.notices,
    unknownStatuses: parsed.unknownStatuses,
    firstDay: parsed.firstDay,
    lastDay: parsed.lastDay,
  };
}

/**
 * A purchase stored without the source's own number (it came from a file that
 * had none for it) is the same purchase when a later file lists it with one.
 * Their identities differ, so it would be stored twice. Where exactly one
 * stored row without a number and exactly one new row with a number agree on
 * day, amount and merchant, the stored row takes the number as its identity
 * and keeps everything else, its links included. Returns how many did.
 */
async function adoptUnreferenced(db: Prisma.TransactionClient, accountId: string, parsed: readonly NormalizedPayment[]): Promise<number> {
  // Purchases only: money back carries its purchase's number and has an identity of its own.
  const numbered = parsed.filter((p) => p.byReference && p.entryReference && p.amountCents < 0);
  if (numbered.length === 0) return 0;
  const known = new Set(
    (await db.taxPayment.findMany({ where: { accountId, sourceHash: { in: numbered.map((p) => p.sourceHash) } }, select: { sourceHash: true } })).map((p) => p.sourceHash),
  );
  const fresh = numbered.filter((p) => !known.has(p.sourceHash));
  if (fresh.length === 0) return 0;
  const sameMovement = (p: { bookingDay: string; amountCents: number; counterpartyKey: string }) => `${p.bookingDay}|${p.amountCents}|${p.counterpartyKey}`;
  const claims = new Map<string, NormalizedPayment[]>();
  for (const p of fresh) {
    const key = sameMovement({ ...p, counterpartyKey: counterpartyKey(p.counterparty) });
    claims.set(key, [...(claims.get(key) ?? []), p]);
  }
  const stored = await db.taxPayment.findMany({ where: { accountId, bookingDay: { in: [...new Set(fresh.map((p) => p.bookingDay))] } } });
  // Stored without a number: its identity is not the hash of a number of its own.
  const unnumbered = stored.filter((p) => p.amountCents < 0 && p.sourceHash !== referenceHash(p.entryReference ?? ''));
  let adopted = 0;
  for (const [key, claimants] of claims) {
    const candidates = unnumbered.filter((p) => sameMovement(p) === key);
    if (claimants.length !== 1 || candidates.length !== 1) continue;
    await db.taxPayment.update({ where: { id: candidates[0].id }, data: { sourceHash: claimants[0].sourceHash, entryReference: claimants[0].entryReference } });
    adopted += 1;
  }
  return adopted;
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
  const payments = await db.taxPayment.findMany({ where: { authWorkspaceId: ctx.workspaceId, amountCents: { gt: 0 }, cancelledByBatchId: null }, include: { links: true } });
  const invoices = await db.taxIssuedInvoice.findMany({ where: { authWorkspaceId: ctx.workspaceId }, include: { payments: true, paymentLinks: { where: { payment: { cancelledByBatchId: null } } } } });
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

/**
 * What an invoice still has open for a payment: its amount less what was typed
 * in, what payments are linked (a purchase list's cancelled payments do not
 * count), and a remainder booked out as never to be paid (a fee the client
 * kept). A booked-out remainder is never offered or linked, whatever its date:
 * the revenue figures count it from its day, but a payment linked on top of it
 * would take payments and write-off beyond the invoice's amount.
 */
function invoiceOpenCents(invoice: { grossCents: number; writtenOffCents: number; writtenOffOn: string | null; payments: Array<{ cents: number }>; paymentLinks: Array<{ cents: number }> }): number {
  const paid = invoice.payments.reduce((s, p) => s + p.cents, 0) + invoice.paymentLinks.reduce((s, l) => s + l.cents, 0);
  const writtenOff = invoice.writtenOffCents > 0 && invoice.writtenOffOn !== null ? invoice.writtenOffCents : 0;
  return Math.max(0, invoice.grossCents - paid - writtenOff);
}

export function effectiveKind(payment: { sourceKind: string; kindOverride: string | null }): PaymentKind {
  const kind = payment.kindOverride ?? payment.sourceKind;
  return (PAYMENT_KINDS as readonly string[]).includes(kind) ? (kind as PaymentKind) : 'spend';
}

/**
 * What a payment is, in this order: the counterparty is an own account (moving
 * money there is no spend, whatever the file calls it); a person re-labelled
 * this one payment; it only funds another imported payment account, or is
 * money back from one (see `funding.ts`); it is on an account the owner said
 * is private as a whole, unless its counterparty is answered business (a
 * business expense paid privately is asked about like any other); otherwise
 * what its file says.
 */
function paymentKind(
  payment: { sourceKind: string; kindOverride: string | null },
  treatment: CounterpartyTreatment | undefined,
  funding: Funding | undefined,
  accountPrivate: boolean,
): PaymentKind {
  if (treatment === 'own_account') return 'own_transfer';
  if (payment.kindOverride === null && funding) return funding.kind;
  if (payment.kindOverride === null && accountPrivate && treatment !== 'business') return 'private';
  return effectiveKind(payment);
}

/**
 * Say that a whole account is private (true) or not (false). Its payments are
 * then not asked about, money in included; the funding rule still makes its
 * transfers transfers, and a single payment can still be linked to a receipt
 * by hand or re-labelled. Nothing stored on the payments changes, so saying
 * `false` brings every question back exactly as before.
 */
export async function setAccountPrivate(db: PrismaClient, ctx: PaymentContext, accountId: string, isPrivate: unknown): Promise<void> {
  if (typeof isPrivate !== 'boolean') throw new PaymentServiceError('invalid_private');
  const { count } = await db.taxAccount.updateMany({ where: { id: accountId, authWorkspaceId: ctx.workspaceId }, data: { isPrivate } });
  if (count === 0) throw new PaymentServiceError('account_not_found');
}

/** Undo an import: the batch goes, with the payments it added and their links. */
export async function deleteImportBatch(db: PrismaClient, ctx: PaymentContext, batchId: string): Promise<void> {
  await db.$transaction(async (tx) => {
    const batch = await tx.taxImportBatch.findFirst({ where: { id: batchId, authWorkspaceId: ctx.workspaceId } });
    if (!batch) throw new PaymentServiceError('batch_not_found');
    // The same lock an import takes: no import of another source reads this one's days while it goes.
    await tx.$queryRaw`SELECT id FROM tax_accounts WHERE id = ${batch.accountId} FOR UPDATE`;
    const batches = orderBatches(await tx.taxImportBatch.findMany({ where: { accountId: batch.accountId }, select: { id: true, format: true, firstDay: true, lastDay: true, createdAt: true } }));
    const later = batches.slice(batches.findIndex((b) => b.id === batch.id) + 1);
    // Another source read later left out the days this one held; undoing this one would leave them empty.
    if (later.some((b) => b.format !== batch.format)) throw new PaymentServiceError('batch_has_later_source');
    // A payment belongs to the file that brought it first. A later file covering the same days relied on those
    // payments being there, so undoing this import would silently take days out of that later file.
    const coverage = batchCoverage(batches);
    const own = coverage.get(batch.id) ?? [];
    if (later.some((b) => overlaps(coverage.get(b.id) ?? [], own))) throw new PaymentServiceError('batch_has_later_overlap');
    // A later import cancelled a purchase this one brought: undone and read again, the purchase would count as paid
    // although that list still says cancelled. And this import cancelled purchases a later file of the list may
    // report too: undone, they would count again.
    const cancelledHere = await tx.taxPayment.count({ where: { batchId: batch.id, cancelledByBatchId: { not: null } } });
    const cancelledByThis = later.length > 0 ? await tx.taxPayment.count({ where: { cancelledByBatchId: batch.id } }) : 0;
    if (cancelledHere > 0 || cancelledByThis > 0) throw new PaymentServiceError('batch_has_later_cancellation');
    // Undone twice at the same moment: the second finds nothing left and says so.
    const { count } = await tx.taxImportBatch.deleteMany({ where: { id: batchId, authWorkspaceId: ctx.workspaceId } });
    if (count === 0) throw new PaymentServiceError('batch_not_found');
  }, { maxWait: 20_000, timeout: 60_000 });
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

/**
 * Say that one payment is a transfer between own accounts, or that it is not.
 * This is how a person overrules the funding rule in both directions: a debit
 * the rule hid is a purchase after all (it goes back to what its file says and
 * is asked about again), or a debit the rule did not catch is a transfer.
 */
export async function setPaymentTransfer(db: PrismaClient, ctx: PaymentContext, paymentId: string, isTransfer: unknown): Promise<void> {
  if (typeof isTransfer !== 'boolean') throw new PaymentServiceError('invalid_kind');
  const payment = await db.taxPayment.findFirst({ where: { id: paymentId, authWorkspaceId: ctx.workspaceId } });
  if (!payment) throw new PaymentServiceError('payment_not_found');
  // "No transfer" is what the file says it is; a file that itself calls it a transfer leaves money out or money in.
  const own = payment.sourceKind === 'own_transfer' ? (payment.amountCents < 0 ? 'spend' : 'income') : payment.sourceKind;
  await db.taxPayment.update({ where: { id: payment.id }, data: { kindOverride: isTransfer ? 'own_transfer' : own } });
}

export interface LinkInput {
  paymentId: string;
  /** Exactly one of the two. */
  rowId?: string | null;
  invoiceId?: string | null;
  /** The part of the payment that belongs to the target; omitted: all that is not linked yet. */
  cents?: number | null;
  /** The person was told the receipt already carries payments and wants this one on it as well. */
  confirmed?: boolean;
}

export interface LinkResult {
  linkId: string;
  /**
   * Set when the receipt's only link sat on the debit that funds this payment
   * (the bank side of the same money): that link was replaced by this one.
   */
  movedFromPaymentId: string | null;
}

/** How a receipt answers for a link: null when it is not this workspace's, otherwise its own euro amount (null: none). */
export type ReceiptForLink = (rowId: string) => Promise<{ amountCents: number | null } | null>;

/** How far the payments of a receipt may go beyond its own amount before a person is asked: fees and exchange rates. */
export const OVERPAID_TOLERANCE_PERCENT = 8;

/**
 * Link a payment (or part of it) to a receipt or an issued invoice, by a
 * person's confirmation. `receiptOf` is how the caller proves a receipt row is
 * this workspace's (rows live in the generic table) and says what it amounts
 * to. `method` records how it came about: picked by hand, or a proposal the
 * person accepted.
 *
 * Three things keep the same money from counting twice on a receipt:
 * a link on the funding debit of this payment is replaced when it is the
 * receipt's only one; links of a payment and its funding debit to the same
 * receipt count once (`countedReceiptLinks`); and a link that takes a receipt
 * beyond its own amount is refused with `receipt_already_paid` until the
 * person confirms it (several payments on one receipt are legitimate: a lease
 * paid in monthly debits).
 */
export async function linkPayment(db: PrismaClient, ctx: PaymentContext, raw: unknown, receiptOf: ReceiptForLink, method: 'manual' | 'estimate' = 'manual'): Promise<LinkResult> {
  const input = (raw ?? {}) as LinkInput;
  const rowId = typeof input.rowId === 'string' && input.rowId ? input.rowId : null;
  const invoiceId = typeof input.invoiceId === 'string' && input.invoiceId ? input.invoiceId : null;
  if (typeof input.paymentId !== 'string' || (rowId === null) === (invoiceId === null)) throw new PaymentServiceError('invalid_link');
  const receipt = rowId !== null ? await receiptOf(rowId) : null;
  if (rowId !== null && receipt === null) throw new PaymentServiceError('target_not_found');

  return db.$transaction(async (tx) => {
    // Lock the payment so two confirmations at the same moment cannot both use its free amount.
    await tx.$queryRaw`SELECT id FROM tax_payments WHERE id = ${input.paymentId} AND auth_workspace_id = ${ctx.workspaceId} FOR UPDATE`;
    const payment = await tx.taxPayment.findFirst({ where: { id: input.paymentId, authWorkspaceId: ctx.workspaceId }, include: { links: true } });
    if (!payment) throw new PaymentServiceError('payment_not_found');
    // A cancelled purchase counts nowhere, so nothing is linked to it.
    if (payment.cancelledByBatchId !== null) throw new PaymentServiceError('invalid_link');
    let free = Math.abs(payment.amountCents) - payment.links.reduce((s, l) => s + l.cents, 0);
    let movedFromPaymentId: string | null = null;
    if (invoiceId !== null) {
      // The invoice is locked too (always after the payment): two payments
      // confirmed for it at the same moment cannot both use what it has open.
      await tx.$queryRaw`SELECT id FROM tax_issued_invoices WHERE id = ${invoiceId} AND auth_workspace_id = ${ctx.workspaceId} FOR UPDATE`;
      const invoice = await tx.taxIssuedInvoice.findFirst({ where: { id: invoiceId, authWorkspaceId: ctx.workspaceId }, include: { payments: true, paymentLinks: { where: { payment: { cancelledByBatchId: null } } } } });
      if (!invoice) throw new PaymentServiceError('target_not_found');
      // Only money received as income pays an invoice: no money going out, no refund, no own transfer.
      if (payment.amountCents <= 0 || effectiveKind(payment) !== 'income') throw new PaymentServiceError('invalid_link');
      // Never more than the invoice still has open: what was typed in by hand
      // and what other payments already cover is not counted a second time.
      const open = invoiceOpenCents(invoice);
      if (open <= 0) throw new PaymentServiceError(invoice.writtenOffCents > 0 && invoice.writtenOffOn !== null ? 'target_written_off' : 'target_fully_paid');
      free = Math.min(free, open);
    }
    const cents = input.cents === undefined || input.cents === null ? free : input.cents;
    if (!Number.isInteger(cents) || cents <= 0) throw new PaymentServiceError('invalid_link');
    if (cents > free) throw new PaymentServiceError('link_exceeds_payment');

    if (rowId !== null) {
      // One writer per receipt (always after the payment): what the receipt
      // already carries is read and judged without another link slipping in.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`tax-receipt:${rowId}`}))`;
      const loaded = await loadPayments(tx, ctx.workspaceId);
      const onReceipt = (p: PaymentRow) => p.links.filter((l) => l.rowId === rowId);
      // An accepted proposal is for a payment and a receipt that are both free;
      // in a second tab one of them may have been linked a moment ago.
      if (method === 'estimate' && (payment.links.length > 0 || loaded.payments.some((p) => onReceipt(p).length > 0))) throw new PaymentServiceError('proposal_gone');
      if (payment.amountCents < 0) {
        const funders = loaded.payments.filter((p) => p.funding?.twinId === payment.id && onReceipt(p).length > 0);
        const others = loaded.payments.filter((p) => p.id !== payment.id && !funders.includes(p) && onReceipt(p).length > 0);
        // The receipt's only link sits on the debit that funds this very purchase: it is the same money, so the link moves here.
        if (funders.length > 0 && others.length === 0 && payment.links.every((l) => l.rowId !== rowId)) {
          await tx.taxPaymentLink.deleteMany({ where: { authWorkspaceId: ctx.workspaceId, rowId, paymentId: { in: funders.map((p) => p.id) } } });
          movedFromPaymentId = funders[0].id;
        } else if (!input.confirmed && receipt && receipt.amountCents !== null) {
          const paidSoFar = paidOnReceipt(loaded.payments, rowId);
          const limit = receipt.amountCents + Math.round((receipt.amountCents * OVERPAID_TOLERANCE_PERCENT) / 100);
          // Counted once when the other end of the same money is on the receipt already: this
          // purchase's funding debit, or the purchase this debit funds.
          const twinId = loaded.payments.find((p) => p.id === payment.id)?.funding?.twinId ?? null;
          const twinOnReceipt = twinId !== null && loaded.payments.some((p) => p.id === twinId && onReceipt(p).length > 0);
          const adds = funders.length > 0 || twinOnReceipt ? 0 : cents;
          if (adds > 0 && paidSoFar > 0 && paidSoFar + adds > limit) throw new PaymentServiceError('receipt_already_paid', `${paidSoFar}:${receipt.amountCents}`);
        }
      }
    }
    const link = await tx.taxPaymentLink.create({
      data: { authWorkspaceId: ctx.workspaceId, authTenantId: ctx.tenantId, paymentId: payment.id, rowId, invoiceId, cents, method },
    });
    return { linkId: link.id, movedFromPaymentId };
  });
}

/**
 * Link accepted proposals, all in one transaction: every payment and receipt
 * is locked, what is stored is read once, and a pair is linked only when its
 * payment and its receipt are both still free (also of each other within this
 * list). The rest is left out. One transaction instead of one per link: with
 * a database a network away, 44 links took half a minute the other way.
 * Returns exactly the pairs that were linked.
 */
export async function linkProposals(db: PrismaClient, ctx: PaymentContext, pairs: ReadonlyArray<{ paymentId: string; rowId: string }>): Promise<Array<{ paymentId: string; rowId: string }>> {
  if (pairs.length === 0) return [];
  return db.$transaction(async (tx) => {
    const paymentIds = [...new Set(pairs.map((p) => p.paymentId))].sort();
    const rowKeys = [...new Set(pairs.map((p) => `tax-receipt:${p.rowId}`))].sort();
    // The same locks, in the same order, as a single link takes: payments first, then receipts.
    await tx.$queryRaw`SELECT id FROM tax_payments WHERE id = ANY(${paymentIds}) AND auth_workspace_id = ${ctx.workspaceId} ORDER BY id FOR UPDATE`;
    await tx.$queryRaw`SELECT count(*)::int AS locked FROM (SELECT pg_advisory_xact_lock(hashtext(k)) FROM unnest(${rowKeys}::text[]) AS k ORDER BY k) AS locks`;
    const loaded = await loadPayments(tx, ctx.workspaceId);
    const free = new Map(loaded.payments.filter((p) => p.links.length === 0 && p.amountCents < 0).map((p) => [p.id, p]));
    const linkedRows = new Set(loaded.payments.flatMap((p) => p.links.flatMap((l) => (l.rowId ? [l.rowId] : []))));
    const linked: Array<{ paymentId: string; rowId: string }> = [];
    for (const pair of pairs) {
      const payment = free.get(pair.paymentId);
      if (!payment || linkedRows.has(pair.rowId)) continue;
      free.delete(pair.paymentId);
      linkedRows.add(pair.rowId);
      linked.push({ paymentId: pair.paymentId, rowId: pair.rowId });
    }
    if (linked.length > 0) {
      const amount = new Map(loaded.payments.map((p) => [p.id, -p.amountCents]));
      await tx.taxPaymentLink.createMany({
        data: linked.map((pair) => ({ authWorkspaceId: ctx.workspaceId, authTenantId: ctx.tenantId, paymentId: pair.paymentId, rowId: pair.rowId, cents: amount.get(pair.paymentId) as number, method: 'estimate' })),
      });
    }
    return linked;
  }, { maxWait: 20_000, timeout: 60_000 });
}

/**
 * The receipt links that count. A payment and the debit that funds it are the
 * same money: when both are linked to the same receipt, the funding side is
 * left out, so the receipt counts what was paid once.
 */
export function countedReceiptLinks(payments: readonly PaymentRow[]): Array<{ payment: PaymentRow; link: PaymentRow['links'][number] & { rowId: string } }> {
  const linkedPurchase = new Set<string>();
  for (const payment of payments) for (const link of payment.links) if (link.rowId) linkedPurchase.add(`${payment.id}|${link.rowId}`);
  const out: Array<{ payment: PaymentRow; link: PaymentRow['links'][number] & { rowId: string } }> = [];
  for (const payment of payments) {
    for (const link of payment.links) {
      if (!link.rowId) continue;
      if (payment.funding?.twinId && linkedPurchase.has(`${payment.funding.twinId}|${link.rowId}`)) continue;
      out.push({ payment, link: { ...link, rowId: link.rowId } });
    }
  }
  return out;
}

/** What the linked payments of a receipt add up to: money out less money back, never below nothing. */
function paidOnReceipt(payments: readonly PaymentRow[], rowId: string): number {
  let cents = 0;
  for (const { payment, link } of countedReceiptLinks(payments)) if (link.rowId === rowId) cents += payment.amountCents < 0 ? link.cents : -link.cents;
  return Math.max(0, cents);
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
  /** What the file itself says the movement is: what "put it back" returns to. */
  sourceKind: PaymentKind;
  /** Set when the funding rule applies to the payment, whether or not a person overruled it (see `funding.ts`). */
  funding: Funding | null;
  /** True when `kind` comes from the funding rule: nobody said it, and it can be overruled. */
  byRule: boolean;
  /**
   * True when `kind` is `private` only because the whole account was said to be
   * private. Such a payment can be money in (a salary) as well as money out:
   * whoever sums private spending reads the sign of `amountCents` or `sourceKind`.
   */
  byPrivateAccount: boolean;
  links: Array<{ id: string; rowId: string | null; invoiceId: string | null; cents: number; method: string }>;
}

export interface LoadedPayments {
  accounts: Array<{ id: string; label: string; kind: string; isPrivate: boolean; paymentCount: number; completeThrough: string | null; batches: Array<{ id: string; format: string; newCount: number; paymentCount: number; firstDay: string | null; lastDay: string | null; importedAt: string }> }>;
  payments: PaymentRow[];
  /**
   * Purchases a later import listed as cancelled or refunded in full. They are
   * in no list, count and sum above; their links are kept (undoing that import
   * brings both back) but count for no receipt.
   */
  cancelled: Array<{ id: string; accountId: string; bookingDay: string; amountCents: number; counterparty: string; rowIds: string[] }>;
  treatments: Map<string, CounterpartyTreatment>;
}

/** Every payment of the workspace with its links, and what was said about the counterparties. */
export async function loadPayments(db: PrismaClient | Prisma.TransactionClient, workspaceId: string): Promise<LoadedPayments> {
  const [accounts, stored, rules] = await Promise.all([
    db.taxAccount.findMany({ where: { authWorkspaceId: workspaceId }, include: { batches: { orderBy: { createdAt: 'desc' } } }, orderBy: { label: 'asc' } }),
    db.taxPayment.findMany({ where: { authWorkspaceId: workspaceId }, include: { links: true }, orderBy: [{ bookingDay: 'asc' }, { createdAt: 'asc' }] }),
    db.taxCounterpartyRule.findMany({ where: { authWorkspaceId: workspaceId } }),
  ]);
  const treatments = new Map<string, CounterpartyTreatment>();
  for (const rule of rules) {
    if ((COUNTERPARTY_TREATMENTS as readonly string[]).includes(rule.treatment)) treatments.set(rule.counterpartyKey, rule.treatment as CounterpartyTreatment);
  }
  const payments = stored.filter((p) => p.cancelledByBatchId === null);
  const funding = resolveFunding(
    accounts.map((a) => ({ id: a.id, kind: a.kind, formats: a.batches.map((b) => b.format) })),
    payments.map((p) => ({ id: p.id, accountId: p.accountId, bookingDay: p.bookingDay, amountCents: p.amountCents, counterpartyKey: p.counterpartyKey, referenceKey: counterpartyKey(p.reference), sourceKind: p.sourceKind })),
  );
  const privateAccounts = new Set(accounts.filter((a) => a.isPrivate).map((a) => a.id));
  const rows: PaymentRow[] = payments.map((p) => {
    const treatment = treatments.get(p.counterpartyKey);
    const funds = funding.get(p.id);
    const kind = paymentKind(p, treatment, funds, privateAccounts.has(p.accountId));
    return {
      id: p.id,
      accountId: p.accountId,
      bookingDay: p.bookingDay,
      amountCents: p.amountCents,
      counterparty: p.counterparty,
      counterpartyKey: p.counterpartyKey,
      reference: p.reference,
      kind,
      kindOverridden: p.kindOverride !== null,
      sourceKind: effectiveKind({ sourceKind: p.sourceKind, kindOverride: null }),
      funding: funds ?? null,
      byRule: funds !== undefined && treatment !== 'own_account' && p.kindOverride === null,
      byPrivateAccount: kind === 'private' && p.kindOverride === null && privateAccounts.has(p.accountId),
      links: p.links.map((l) => ({ id: l.id, rowId: l.rowId, invoiceId: l.invoiceId, cents: l.cents, method: l.method })),
    };
  });
  return {
    accounts: accounts.map((a) => {
      const own = rows.filter((r) => r.accountId === a.id);
      return {
        id: a.id,
        label: a.label,
        kind: a.kind,
        isPrivate: a.isPrivate,
        paymentCount: own.length,
        // The last booked day the account has data for: how fresh this source is.
        completeThrough: own.length > 0 ? own[own.length - 1].bookingDay : null,
        batches: a.batches.map((b) => ({ id: b.id, format: b.format, newCount: b.newCount, paymentCount: b.paymentCount, firstDay: b.firstDay, lastDay: b.lastDay, importedAt: b.createdAt.toISOString() })),
      };
    }),
    payments: rows,
    cancelled: stored
      .filter((p) => p.cancelledByBatchId !== null)
      .map((p) => ({ id: p.id, accountId: p.accountId, bookingDay: p.bookingDay, amountCents: p.amountCents, counterparty: p.counterparty, rowIds: p.links.flatMap((l) => (l.rowId ? [l.rowId] : [])) })),
    treatments,
  };
}

/** A payment found by `findPayments`, with what it can be linked to by hand. */
export interface FoundPayment {
  id: string;
  bookingDay: string;
  amountCents: number;
  /** What of it is not linked to anything yet (positive). */
  freeCents: number;
  counterparty: string;
  reference: string;
  kind: PaymentKind;
  accountLabel: string;
  /** Money received as income goes on an issued invoice; money out and money back on a receipt. */
  target: 'receipt' | 'invoice';
}

/** At most this many payments come back from one search: enough to pick from, small enough to draw. */
export const FIND_PAYMENTS_LIMIT = 100;

/**
 * Payments of one year that still have something to link, found by their
 * counterparty or by a text (an amount is compared as an amount), whatever the
 * questions say about them: a payment to a counterparty nobody answered yet,
 * to one answered as mixed, or on an account said to be private can be linked
 * by hand without answering anything for its other payments. Left out is what
 * no document belongs to: fees, transfers a person or a counterparty answer
 * made (a transfer the funding rule made stays findable, a link on it is how
 * a person keeps a receipt on the bank side), and money in that is neither
 * income nor money back. Read only.
 */
export async function findPayments(db: PrismaClient, workspaceId: string, raw: unknown): Promise<{ payments: FoundPayment[]; total: number }> {
  const input = (raw ?? {}) as { year?: unknown; counterpartyKey?: unknown; text?: unknown };
  const year = typeof input.year === 'number' && Number.isInteger(input.year) ? input.year : null;
  if (year === null) throw new PaymentServiceError('invalid_query');
  const key = typeof input.counterpartyKey === 'string' && input.counterpartyKey !== '' ? input.counterpartyKey : null;
  const text = typeof input.text === 'string' ? input.text.trim().toLowerCase().slice(0, 80) : '';
  const cents = amountQuery(text);
  if (key === null && text.length < 2) return { payments: [], total: 0 };
  const loaded = await loadPayments(db, workspaceId);
  const accountLabel = new Map(loaded.accounts.map((a) => [a.id, a.label]));
  const found: FoundPayment[] = [];
  let total = 0;
  for (const p of loaded.payments) {
    if (!p.bookingDay.startsWith(`${year}-`)) continue;
    if (key !== null && p.counterpartyKey !== key) continue;
    if (text && !(cents !== null && Math.abs(p.amountCents) === cents) && !`${p.counterparty} ${p.reference}`.toLowerCase().includes(text)) continue;
    const freeCents = Math.abs(p.amountCents) - p.links.reduce((sum, l) => sum + l.cents, 0);
    if (freeCents <= 0) continue;
    // What the file (or a person) says, beneath the account's "private": decides invoice or receipt.
    const own = p.byPrivateAccount ? p.sourceKind : p.kind;
    if (own === 'fee' || (own === 'own_transfer' && !p.byRule)) continue;
    if (p.amountCents > 0 && own !== 'income' && own !== 'refund') continue;
    total += 1;
    if (found.length >= FIND_PAYMENTS_LIMIT) continue;
    found.push({
      id: p.id,
      bookingDay: p.bookingDay,
      amountCents: p.amountCents,
      freeCents,
      counterparty: p.counterparty,
      reference: p.reference,
      kind: p.kind,
      accountLabel: accountLabel.get(p.accountId) ?? '',
      target: p.amountCents > 0 && own === 'income' ? 'invoice' : 'receipt',
    });
  }
  return { payments: found, total };
}

export type { MatchProposal };
