import 'server-only';
import { Prisma, type PrismaClient } from '@prisma/client';
import { loadPayments, OVERPAID_TOLERANCE_PERCENT, PaymentServiceError, type CounterpartyTreatment, type PaymentContext, type PaymentRow, type ReceiptForLink } from './service';
import { routesToReceiver } from './route';

/**
 * Payments across companies (plan docs/plans/2026-10-22-payments-across-companies.md).
 *
 * An account belongs to one company, the holder. A person who is a member of
 * two companies can share an account's private payments with the other one,
 * the receiver. Nothing is copied: which payment belongs where is worked out on
 * read (`routesToReceiver`), from the holder's answers.
 *
 * `loadPayments` stays the read of the payments area and of the tax figures,
 * and reads only the company's own links. `loadRoutedPayments` is the read of
 * the spending side: the company's own payments less the ones it routes away,
 * plus the ones routed to it, with its own links on them. Every write a
 * receiver can make on a payment re-derives the routing inside its own
 * transaction and refuses a payment that does not route to it, with the same
 * answer as an unknown payment.
 */

export type ShareErrorCode =
  | 'account_not_found'
  /** The account is shared already; one receiver per account. */
  | 'already_shared'
  /** The receiver is the holder itself. */
  | 'same_company'
  | 'share_not_found';

export class ShareError extends Error {
  readonly code: ShareErrorCode;
  constructor(code: ShareErrorCode) {
    super(code);
    this.name = 'ShareError';
    this.code = code;
  }
}

type Db = PrismaClient | Prisma.TransactionClient;

/** A payment as the spending side of one company reads it. */
export interface RoutedPaymentRow extends PaymentRow {
  /** The holder's workspace when this payment is here because the holder's answers call it private; null for the company's own payments. */
  routedFrom: string | null;
}

export interface RoutedAccount {
  id: string;
  label: string;
  completeThrough: string | null;
  /** The holder's workspace when this is another company's account whose private payments come here. */
  sharedFrom: string | null;
}

export interface RoutedPayments {
  accounts: RoutedAccount[];
  payments: RoutedPaymentRow[];
  /** This company's own counterparty answers (a routed payment is private whatever they say). */
  treatments: Map<string, CounterpartyTreatment>;
  /** The workspaces of the companies whose accounts route payments here (their category and "no receipt" answers apply to those payments). */
  holders: string[];
  /** Accounts of this company whose private payments go to another company. */
  sharedOut: Array<{ shareId: string; accountId: string; accountLabel: string; receiverWorkspaceId: string }>;
}

/**
 * The spending side's read of one company: its own payments less those it
 * routes to another company, plus those other companies route to it (with
 * this company's own links on them, never the holder's).
 */
export async function loadRoutedPayments(db: Db, workspaceId: string): Promise<RoutedPayments> {
  const [own, outgoing, incoming] = await Promise.all([
    loadPayments(db, workspaceId),
    db.taxAccountShare.findMany({ where: { authWorkspaceId: workspaceId }, include: { account: { select: { label: true, authWorkspaceId: true } } } }),
    db.taxAccountShare.findMany({ where: { receiverWorkspaceId: workspaceId }, include: { account: { select: { authWorkspaceId: true } } } }),
  ]);
  // A share whose account is not the holder's any more (it cannot move, but nothing is trusted) routes nothing.
  const validOut = outgoing.filter((s) => s.account.authWorkspaceId === workspaceId && s.receiverWorkspaceId !== workspaceId);
  const sharedOut = new Set(validOut.map((s) => s.accountId));
  const kept: RoutedPaymentRow[] = own.payments.filter((p) => !routesToReceiver(p, own.treatments, sharedOut)).map((p) => ({ ...p, routedFrom: null }));
  const accounts: RoutedAccount[] = own.accounts.map((a) => ({ id: a.id, label: a.label, completeThrough: a.completeThrough, sharedFrom: null }));

  const byHolder = new Map<string, Set<string>>();
  for (const s of incoming) {
    if (s.account.authWorkspaceId !== s.authWorkspaceId || s.authWorkspaceId === workspaceId) continue;
    byHolder.set(s.authWorkspaceId, (byHolder.get(s.authWorkspaceId) ?? new Set()).add(s.accountId));
  }
  const routedIn: RoutedPaymentRow[] = [];
  for (const [holder, accountIds] of byHolder) {
    const loaded = await loadPayments(db, holder);
    for (const a of loaded.accounts) {
      if (accountIds.has(a.id)) accounts.push({ id: a.id, label: a.label, completeThrough: a.completeThrough, sharedFrom: holder });
    }
    for (const p of loaded.payments) if (routesToReceiver(p, loaded.treatments, accountIds)) routedIn.push({ ...p, routedFrom: holder });
  }
  // This company's own links on what is routed to it; the holder's are never shown here (there are none: a payment the holder linked stays there).
  const links = routedIn.length === 0 ? [] : await db.taxPaymentLink.findMany({ where: { authWorkspaceId: workspaceId, paymentId: { in: routedIn.map((p) => p.id) } } });
  const linksOf = new Map<string, PaymentRow['links']>();
  for (const l of links) linksOf.set(l.paymentId, [...(linksOf.get(l.paymentId) ?? []), { id: l.id, rowId: l.rowId, invoiceId: l.invoiceId, cents: l.cents, method: l.method }]);
  const incomingRows = routedIn.map((p) => ({
    ...p,
    links: linksOf.get(p.id) ?? [],
    // The funding rule pairs payments of the holder's accounts; its twin is not here.
    funding: null,
    byRule: false,
    // Private because it was routed here, not because of an account: `routedFrom` says so.
    byPrivateAccount: false,
  }));

  const payments = [...kept, ...incomingRows].sort((a, b) => (a.bookingDay < b.bookingDay ? -1 : a.bookingDay > b.bookingDay ? 1 : 0));
  return {
    accounts,
    payments,
    treatments: own.treatments,
    holders: [...byHolder.keys()],
    sharedOut: validOut.map((s) => ({ shareId: s.id, accountId: s.accountId, accountLabel: s.account.label, receiverWorkspaceId: s.receiverWorkspaceId })),
  };
}

/**
 * The payment `paymentId` as the receiver `workspaceId` may act on it: the
 * holder's row, when the account is shared with this company and the
 * holder's answers route it here right now; null otherwise (also for a
 * payment of another company that is not routed, which must look exactly
 * like one that does not exist).
 */
export async function routedPaymentFor(db: Db, workspaceId: string, paymentId: string): Promise<{ row: PaymentRow; holderWorkspaceId: string } | null> {
  const payment = await db.taxPayment.findUnique({ where: { id: paymentId }, select: { accountId: true, authWorkspaceId: true, account: { select: { share: true } } } });
  const share = payment?.account.share;
  if (!payment || !share || share.receiverWorkspaceId !== workspaceId || share.authWorkspaceId !== payment.authWorkspaceId || payment.authWorkspaceId === workspaceId) return null;
  const loaded = await loadPayments(db, payment.authWorkspaceId);
  const row = loaded.payments.find((p) => p.id === paymentId);
  if (!row || !routesToReceiver(row, loaded.treatments, new Set([payment.accountId]))) return null;
  return { row, holderWorkspaceId: payment.authWorkspaceId };
}

/**
 * Is this payment one the company `workspaceId` sees on its spending side? Its
 * own payment that is not routed away, or one routed to it.
 */
export async function paymentOnSpendingSide(db: Db, workspaceId: string, paymentId: string): Promise<boolean> {
  const payment = await db.taxPayment.findUnique({ where: { id: paymentId }, select: { authWorkspaceId: true, accountId: true, account: { select: { share: true } } } });
  if (!payment) return false;
  if (payment.authWorkspaceId !== workspaceId) return (await routedPaymentFor(db, workspaceId, paymentId)) !== null;
  const share = payment.account.share;
  if (!share || share.receiverWorkspaceId === workspaceId) return true;
  const loaded = await loadPayments(db, workspaceId);
  const row = loaded.payments.find((p) => p.id === paymentId);
  return row !== undefined && !routesToReceiver(row, loaded.treatments, new Set([payment.accountId]));
}

/**
 * The receiver links its own receipt to a payment routed to it. The link is
 * the receiver's (its workspace and company stamp) and covers what of the
 * payment the receiver has not linked yet. Refused as `payment_not_found` for
 * any payment that does not route to the receiver right now. Like the
 * holder's own link, a receipt already paid by other payments is not taken
 * beyond its amount (plus the tolerance for fees and rates) unless
 * `confirmed`: `receipt_already_paid` with "<paid so far>:<receipt amount>".
 */
export async function linkRoutedPayment(
  db: PrismaClient,
  ctx: PaymentContext,
  paymentId: string,
  rowId: string,
  receiptOf: ReceiptForLink,
  options: { confirmed?: boolean } = {},
): Promise<{ linkId: string }> {
  if (typeof paymentId !== 'string' || !paymentId || typeof rowId !== 'string' || !rowId) throw new PaymentServiceError('invalid_link');
  const receipt = await receiptOf(rowId);
  if (receipt === null) throw new PaymentServiceError('target_not_found');
  return db.$transaction(async (tx) => {
    // The same lock order as the holder's own link: the payment first, then the receipt.
    await tx.$queryRaw`SELECT id FROM tax_payments WHERE id = ${paymentId} FOR UPDATE`;
    const routed = await routedPaymentFor(tx, ctx.workspaceId, paymentId);
    if (!routed) throw new PaymentServiceError('payment_not_found');
    // Only money out asks for a receipt; money back goes on its purchase in the company that holds it.
    if (routed.row.amountCents >= 0) throw new PaymentServiceError('invalid_link');
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`tax-receipt:${rowId}`}))`;
    const mine = await tx.taxPaymentLink.findMany({ where: { authWorkspaceId: ctx.workspaceId, paymentId } });
    const same = mine.find((l) => l.rowId === rowId);
    if (same) return { linkId: same.id };
    const free = Math.abs(routed.row.amountCents) - mine.reduce((sum, l) => sum + l.cents, 0);
    if (free <= 0) throw new PaymentServiceError('link_exceeds_payment');
    if (!options.confirmed && receipt.amountCents !== null) {
      // Every link of this company on the receipt, its own payments' and routed ones' alike (one that moved
      // back to the holder too: it is the receipt's payment until it is taken back).
      const onReceipt = await tx.taxPaymentLink.findMany({ where: { authWorkspaceId: ctx.workspaceId, rowId }, select: { cents: true, payment: { select: { amountCents: true } } } });
      const paid = Math.max(0, onReceipt.reduce((sum, l) => sum + (l.payment.amountCents < 0 ? l.cents : -l.cents), 0));
      const limit = receipt.amountCents + Math.round((receipt.amountCents * OVERPAID_TOLERANCE_PERCENT) / 100);
      if (paid > 0 && paid + free > limit) throw new PaymentServiceError('receipt_already_paid', `${paid}:${receipt.amountCents}`);
    }
    const link = await tx.taxPaymentLink.create({
      data: { authWorkspaceId: ctx.workspaceId, authTenantId: ctx.tenantId, paymentId, rowId, cents: free, method: 'manual' },
    });
    return { linkId: link.id };
  });
}

/** The receiver takes its links on a routed payment back. Returns how many went. */
export async function unlinkRoutedPayment(db: PrismaClient, ctx: PaymentContext, paymentId: string): Promise<number> {
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM tax_payments WHERE id = ${paymentId} FOR UPDATE`;
    if (!(await routedPaymentFor(tx, ctx.workspaceId, paymentId))) throw new PaymentServiceError('payment_not_found');
    const { count } = await tx.taxPaymentLink.deleteMany({ where: { authWorkspaceId: ctx.workspaceId, paymentId } });
    if (count === 0) throw new PaymentServiceError('link_not_found');
    return count;
  });
}

// ── Shares ───────────────────────────────────────────────────────────────────

/**
 * Share an account's private payments with another company. The caller has
 * checked that the person is a member of both companies with the write
 * permission in both; this checks the account is the holder's and not shared.
 */
export async function shareAccount(db: PrismaClient, holder: PaymentContext, accountId: string, receiver: PaymentContext, userId: string): Promise<string> {
  if (receiver.workspaceId === holder.workspaceId) throw new ShareError('same_company');
  const account = await db.taxAccount.findFirst({ where: { id: accountId, authWorkspaceId: holder.workspaceId }, select: { id: true } });
  if (!account) throw new ShareError('account_not_found');
  try {
    const share = await db.taxAccountShare.create({
      data: {
        authWorkspaceId: holder.workspaceId,
        authTenantId: holder.tenantId,
        accountId,
        receiverWorkspaceId: receiver.workspaceId,
        receiverTenantId: receiver.tenantId,
        createdByUserId: userId,
      },
    });
    return share.id;
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new ShareError('already_shared');
    throw e;
  }
}

/**
 * End a share, from either side. The payments are back with the holder at
 * once; the receiver's links stay, counted nowhere. Returns the two companies
 * of the share, so the caller can settle their message queues.
 */
export async function endShare(db: PrismaClient, workspaceId: string, shareId: string): Promise<{ holder: PaymentContext; receiver: PaymentContext }> {
  const where = { id: shareId, OR: [{ authWorkspaceId: workspaceId }, { receiverWorkspaceId: workspaceId }] };
  return db.$transaction(async (tx) => {
    const share = await tx.taxAccountShare.findFirst({ where });
    if (!share) throw new ShareError('share_not_found');
    const { count } = await tx.taxAccountShare.deleteMany({ where });
    if (count === 0) throw new ShareError('share_not_found');
    return { holder: { workspaceId: share.authWorkspaceId, tenantId: share.authTenantId }, receiver: { workspaceId: share.receiverWorkspaceId, tenantId: share.receiverTenantId } };
  });
}

export interface ShareView {
  id: string;
  accountId: string;
  accountLabel: string;
  /** The other company of the share: the receiver for an outgoing share, the holder for an incoming one. */
  otherWorkspaceId: string;
  createdAt: string;
}

/** The shares of a company: its accounts shared out, and other companies' accounts shared with it. */
export async function loadShares(db: PrismaClient, workspaceId: string): Promise<{ outgoing: ShareView[]; incoming: ShareView[] }> {
  const rows = await db.taxAccountShare.findMany({
    where: { OR: [{ authWorkspaceId: workspaceId }, { receiverWorkspaceId: workspaceId }] },
    include: { account: { select: { label: true } } },
    orderBy: { createdAt: 'asc' },
  });
  const view = (r: (typeof rows)[number], other: string): ShareView => ({ id: r.id, accountId: r.accountId, accountLabel: r.account.label, otherWorkspaceId: other, createdAt: r.createdAt.toISOString() });
  return {
    outgoing: rows.filter((r) => r.authWorkspaceId === workspaceId).map((r) => view(r, r.receiverWorkspaceId)),
    incoming: rows.filter((r) => r.receiverWorkspaceId === workspaceId && r.authWorkspaceId !== workspaceId).map((r) => view(r, r.authWorkspaceId)),
  };
}

/** The companies that receive private payments of accounts these companies hold, without the holders themselves. */
export async function receiversOf(db: Db, holderWorkspaceIds: readonly string[]): Promise<PaymentContext[]> {
  if (holderWorkspaceIds.length === 0) return [];
  const rows = await db.taxAccountShare.findMany({ where: { authWorkspaceId: { in: [...holderWorkspaceIds] } }, select: { receiverWorkspaceId: true, receiverTenantId: true } });
  const out = new Map<string, PaymentContext>();
  for (const r of rows) if (!holderWorkspaceIds.includes(r.receiverWorkspaceId)) out.set(r.receiverWorkspaceId, { workspaceId: r.receiverWorkspaceId, tenantId: r.receiverTenantId });
  return [...out.values()];
}

/** Is `workspaceId` the receiver of a share of an account that `holderWorkspaceId` holds? */
export async function receivesFrom(db: Db, workspaceId: string, holderWorkspaceId: string): Promise<boolean> {
  if (workspaceId === holderWorkspaceId) return false;
  return (await db.taxAccountShare.count({ where: { authWorkspaceId: holderWorkspaceId, receiverWorkspaceId: workspaceId } })) > 0;
}

/**
 * An erased company (auth-brain's `tenant.erased`) keeps nothing tied to
 * another company's records: every share it is part of ends, and every link
 * one company holds on another company's payment where either is the erased
 * one goes. The payments stay the holder's records. Repeat-safe. Returns how
 * many shares ended and how many links went.
 */
export async function endCompanyAccountShares(db: PrismaClient, tenantId: string, workspaceIds: readonly string[]): Promise<{ shares: number; links: number }> {
  const ids = [...workspaceIds];
  return db.$transaction(async (tx) => {
    const links = await tx.$executeRaw`
      DELETE FROM tax_payment_links l USING tax_payments p
      WHERE l.payment_id = p.id
        AND l.auth_workspace_id <> p.auth_workspace_id
        AND (l.auth_tenant_id = ${tenantId} OR p.auth_tenant_id = ${tenantId} OR l.auth_workspace_id = ANY(${ids}::text[]) OR p.auth_workspace_id = ANY(${ids}::text[]))`;
    const { count } = await tx.taxAccountShare.deleteMany({
      where: {
        OR: [
          { authTenantId: tenantId },
          { receiverTenantId: tenantId },
          ...(ids.length > 0 ? [{ authWorkspaceId: { in: ids } }, { receiverWorkspaceId: { in: ids } }] : []),
        ],
      },
    });
    return { shares: count, links };
  });
}
