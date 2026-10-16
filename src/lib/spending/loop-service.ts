import 'server-only';
import { Prisma, type PrismaClient } from '@prisma/client';
import { allReceiptRows, tableContext } from '@/lib/meals/service';
import { rowToMealRecord } from '@/lib/meals/record';
import { vendorKey } from '@/lib/tax/decisions';
import { eurosToCents, formatCents } from '@/lib/tax/money';
import { linkPayment, loadPayments, type PaymentRow } from '@/lib/tax/payments/service';
import { receiptForLink } from '@/lib/tax/service';
import { loadCategoryAnswers } from './service';
import { loopState, mailFoundSubject, missingReceiptSubject, notifiable, type LoopContext, type LoopReceipt, type LoopState, type NotNeededReason, type ReceiptCandidate } from './loop';
import { notify, retryFailedDeliveries, serverChannels, settleAllBut, settleNotifications, type NotifyContext } from './notify/service';
import type { NotificationChannel } from './notify/port';
import { serverMailbox } from './mailbox/gmail';
import { mailWordsFor, type MailboxPort } from './mailbox/port';
import { spendingPath } from './paths';
import { forgetGonePayments, loadMailCandidates, searchMailbox, type MailboxRun } from './mailbox/service';

/**
 * The missing-receipt loop against the database: what it reads, the open
 * checks it shows, the answers a person gives, and the run that notifies.
 * Every function takes the workspace explicitly; receipts and payments are
 * only ever matched within one company.
 */

export type LoopServiceErrorCode = 'payment_not_found' | 'reason_required' | 'not_a_candidate';

export class LoopServiceError extends Error {
  readonly code: LoopServiceErrorCode;
  constructor(code: LoopServiceErrorCode) {
    super(code);
    this.name = 'LoopServiceError';
    this.code = code;
  }
}

/** The receipts of the workspace as the loop sees them; empty before the Receipts table exists. */
export async function loadLoopReceipts(db: PrismaClient, workspaceId: string, linkedRowIds: ReadonlySet<string>): Promise<LoopReceipt[]> {
  const ctx = await tableContext(db, workspaceId);
  if (!ctx) return [];
  const rows = (await allReceiptRows(ctx.adapter, ctx.tableId, ctx.columns)).filter((r) => !r.archived);
  return rows.map((row) => {
    const record = rowToMealRecord(row, ctx.columns, ctx.selectOptions, []);
    const foreign = record.currency !== 'EUR';
    const amountCents =
      record.gross === null ? null : !foreign ? eurosToCents(record.gross) : record.fxRate ? Math.round(eurosToCents(record.gross) * record.fxRate) : null;
    return {
      rowId: row.id,
      label: record.name ?? record.vendor ?? 'Beleg',
      vendor: record.vendor,
      vendorKey: vendorKey(record.vendor),
      day: record.date,
      amountCents,
      estimated: foreign,
      linked: linkedRowIds.has(row.id),
    };
  });
}

/** Vendors each counterparty stands for, learned from the links that exist (as the payments tab does). */
function vendorAliases(payments: readonly PaymentRow[], receipts: readonly LoopReceipt[]): Map<string, Set<string>> {
  const vendorByRow = new Map(receipts.map((r) => [r.rowId, r.vendorKey]));
  const out = new Map<string, Set<string>>();
  for (const p of payments) {
    if (!p.counterpartyKey || p.amountCents >= 0) continue;
    for (const link of p.links) {
      const vendor = link.rowId ? vendorByRow.get(link.rowId) : null;
      if (vendor) out.set(p.counterpartyKey, (out.get(p.counterpartyKey) ?? new Set()).add(vendor));
    }
  }
  return out;
}

export interface PaymentCheck {
  paymentId: string;
  bookingDay: string;
  /** Money out as a positive number. */
  cents: number;
  counterparty: string;
  reference: string;
  state: LoopState;
}

export interface LoopOverview {
  /** Payments waiting on a person: a receipt fits and needs confirming, or the receipt is missing. Newest first. */
  open: PaymentCheck[];
  /** Payments a person answered "no receipt exists" for, newest first: the answer can be taken back. */
  answered: PaymentCheck[];
  counts: { hasReceipt: number; notNeeded: Record<NotNeededReason, number>; noReceipt: number; proposed: number; in_mailbox: number; missing: number };
}

interface Loaded {
  payments: PaymentRow[];
  states: Map<string, LoopState>;
  /** Vendor keys each counterparty stands for, learned from links: the names a mailbox search uses besides the counterparty's own. */
  aliases: Map<string, Set<string>>;
}

async function computeStates(db: PrismaClient, workspaceId: string): Promise<Loaded> {
  const [loaded, answers, noReceipt, mailCandidates] = await Promise.all([
    loadPayments(db, workspaceId),
    loadCategoryAnswers(db, workspaceId),
    db.spendingReceiptAnswer.findMany({ where: { authWorkspaceId: workspaceId } }),
    loadMailCandidates(db, workspaceId),
  ]);
  const linkedRows = new Set(loaded.payments.flatMap((p) => p.links.flatMap((l) => (l.rowId ? [l.rowId] : []))));
  const receipts = await loadLoopReceipts(db, workspaceId, linkedRows);
  const aliases = vendorAliases(loaded.payments, receipts);
  const ctx: LoopContext = {
    treatments: loaded.treatments,
    categoryAnswers: new Map(answers.map((a) => [a.counterpartyKey, a.category])),
    noReceipt: new Map(noReceipt.map((a) => [a.paymentId, a.reason])),
    receipts,
    vendorAliases: aliases,
    mailCandidates,
  };
  const states = new Map<string, LoopState>();
  for (const p of loaded.payments) {
    states.set(p.id, loopState({ ...p, linkCount: p.links.length }, ctx));
  }
  return { payments: loaded.payments, states, aliases };
}

const check = (p: PaymentRow, state: LoopState): PaymentCheck => ({
  paymentId: p.id,
  bookingDay: p.bookingDay,
  cents: -p.amountCents,
  counterparty: p.counterparty,
  reference: p.reference,
  state,
});

export async function loadLoopOverview(db: PrismaClient, workspaceId: string): Promise<LoopOverview> {
  const { payments, states } = await computeStates(db, workspaceId);
  const counts: LoopOverview['counts'] = {
    hasReceipt: 0,
    notNeeded: { own_transfer: 0, income: 0, refund: 0, fee: 0, loan: 0, cash: 0, transfer: 0 },
    noReceipt: 0,
    proposed: 0,
    // Named like the state it counts (`counts[state.state]`), hence not camel case.
    in_mailbox: 0,
    missing: 0,
  };
  const open: PaymentCheck[] = [];
  const answered: PaymentCheck[] = [];
  for (const p of payments) {
    const state = states.get(p.id) as LoopState;
    if (state.state === 'has_receipt') counts.hasReceipt += 1;
    else if (state.state === 'not_needed') counts.notNeeded[state.reason] += 1;
    else if (state.state === 'no_receipt') {
      counts.noReceipt += 1;
      answered.push(check(p, state));
    } else {
      counts[state.state] += 1;
      open.push(check(p, state));
    }
  }
  const newest = (a: PaymentCheck, b: PaymentCheck) => (a.bookingDay < b.bookingDay ? 1 : a.bookingDay > b.bookingDay ? -1 : 0);
  return { open: open.sort(newest), answered: answered.sort(newest), counts };
}

function missingMessage(p: PaymentRow, inMailbox: boolean, workspaceId: string): { title: string; body: string; path: string } {
  const who = p.counterparty || p.reference || 'eine Zahlung ohne Namen';
  const [y, m, d] = p.bookingDay.split('-');
  if (inMailbox) {
    return {
      title: `Rechnung im Postfach: ${who}`,
      body: `Für ${formatCents(-p.amountCents)} € an ${who} am ${d}.${m}.${y} liegt im Ausgaben-Postfach eine passende Rechnung. Mit einem Tipp wird sie als Beleg übernommen.`,
      path: spendingPath(workspaceId, { pruefen: p.id }),
    };
  }
  return {
    title: `Beleg fehlt: ${who}`,
    body: `Für ${formatCents(-p.amountCents)} € an ${who} am ${d}.${m}.${y} gibt es noch keinen Beleg. Bitte fotografieren oder hochladen, oder sagen, dass es keinen gibt.`,
    path: spendingPath(workspaceId, { pruefen: p.id }),
  };
}

/** New notifications sent in one run at most; the rest follow on the next run. */
export const MAX_SENDS_PER_RUN = 10;

export interface RunResult {
  /** Notifications newly created in this run. */
  notified: number;
  /** Missing receipts not notified about yet, left for the next run because this run reached its limit. */
  deferred: number;
  /** Notifications taken out of the in-app queue because their payment is settled now. */
  settled: number;
  /** Failed deliveries that were tried again. */
  retried: number;
  open: number;
  /** What the mailbox search (step 3) did in this run. */
  mailbox: MailboxRun;
}

/**
 * One run of the loop over every imported payment of the workspace: notify
 * about recent payments whose receipt is missing (each at most once, ever),
 * take settled ones out of the in-app queue, and try failed deliveries again.
 * Safe to run any number of times; meant to run after every payment import.
 */
export async function runReceiptLoop(
  db: PrismaClient,
  ctx: NotifyContext,
  options: { today: string; channels?: readonly NotificationChannel[]; now?: Date; mailbox?: MailboxPort },
): Promise<RunResult> {
  const channels = options.channels ?? serverChannels(db);
  await forgetGonePayments(db, ctx.workspaceId);
  let { payments, states, aliases } = await computeStates(db, ctx.workspaceId);
  // Step 3: look in the mailbox for the invoices of recent payments still missing one, by the
  // counterparty's name and the vendors it is known to stand for, then read the states again.
  const lookFor = payments
    .filter((p) => states.get(p.id)?.state === 'missing' && notifiable(p, options.today))
    .map((p) => ({ id: p.id, bookingDay: p.bookingDay, amountCents: p.amountCents, vendorWords: p.counterpartyKey ? mailWordsFor(p.counterparty, p.counterpartyKey, aliases.get(p.counterpartyKey) ?? []) : [] }));
  const mailbox = await searchMailbox(db, ctx, lookFor, options.mailbox ?? serverMailbox(ctx.workspaceId), options.now);
  if (mailbox.status !== 'off' && mailbox.found > 0) ({ payments, states, aliases } = await computeStates(db, ctx.workspaceId));
  const waiting: PaymentRow[] = [];
  const inMailbox = new Set<string>();
  let open = 0;
  for (const p of payments) {
    const state = states.get(p.id) as LoopState;
    if (state.state === 'missing' || state.state === 'proposed' || state.state === 'in_mailbox') open += 1;
    // A payment still waiting for its receipt keeps its messages: missing, or its invoice found in the
    // mailbox and not taken over yet. A proposal waiting for confirmation ends them; the open checks show it.
    if (state.state === 'missing' || state.state === 'in_mailbox') waiting.push(p);
    if (state.state === 'in_mailbox') inMailbox.add(p.id);
  }
  // In this order: what is settled (or gone with an undone import) leaves the
  // queue and is never retried, earlier failed deliveries are tried again, and
  // only then are new ones sent, so a notification created in this run is not
  // tried twice in it.
  const stillOpen = new Set(waiting.flatMap((p) => [missingReceiptSubject(p.id), ...(inMailbox.has(p.id) ? [mailFoundSubject(p.id)] : [])]));
  const settled = await settleAllBut(db, ctx.workspaceId, 'missing_receipt', stillOpen);
  const retried = await retryFailedDeliveries(db, ctx.workspaceId, channels, options.now);
  let notified = 0;
  let deferred = 0;
  // One message per payment and kind: "receipt missing", and "invoice in the mailbox" once it is found
  // (also when that happens on a later search, after the first message).
  const subjectOf = (p: PaymentRow) => (inMailbox.has(p.id) ? mailFoundSubject(p.id) : missingReceiptSubject(p.id));
  const recent = waiting.filter((p) => notifiable(p, options.today));
  // Payments notified about before are done for good: only the rest count towards the limit.
  const notifiedBefore = new Set(
    (
      await db.spendingNotification.findMany({
        where: { authWorkspaceId: ctx.workspaceId, kind: 'missing_receipt', subjectKey: { in: recent.map(subjectOf) } },
        select: { subjectKey: true },
      })
    ).map((n) => n.subjectKey),
  );
  const due = recent
    .filter((p) => !notifiedBefore.has(subjectOf(p)))
    .sort((a, b) => (a.bookingDay < b.bookingDay ? 1 : a.bookingDay > b.bookingDay ? -1 : 0));
  // Newest first, and at most a handful per run: a slow mail service must not
  // hold the import or the button for minutes. The rest go on the next run.
  for (const p of due) {
    if (notified >= MAX_SENDS_PER_RUN) {
      deferred += 1;
      continue;
    }
    const message = missingMessage(p, inMailbox.has(p.id), ctx.workspaceId);
    if ((await notify(db, ctx, { subjectKey: subjectOf(p), kind: 'missing_receipt', ...message }, channels)) === 'sent') notified += 1;
  }
  return { notified, deferred, settled, retried, open, mailbox };
}

async function requirePayment(db: PrismaClient, workspaceId: string, paymentId: string): Promise<void> {
  const found = await db.taxPayment.findFirst({ where: { id: paymentId, authWorkspaceId: workspaceId }, select: { id: true } });
  if (!found) throw new LoopServiceError('payment_not_found');
}

/** "No receipt exists for this payment", with the reason. Answered once, never asked again. */
export async function answerNoReceipt(db: PrismaClient, ctx: NotifyContext, paymentId: string, rawReason: unknown): Promise<void> {
  const reason = typeof rawReason === 'string' ? rawReason.trim().slice(0, 500) : '';
  if (!reason) throw new LoopServiceError('reason_required');
  await requirePayment(db, ctx.workspaceId, paymentId);
  const save = () =>
    db.spendingReceiptAnswer.upsert({
      where: { authWorkspaceId_paymentId: { authWorkspaceId: ctx.workspaceId, paymentId } },
      create: { authWorkspaceId: ctx.workspaceId, authTenantId: ctx.tenantId, paymentId, reason },
      update: { reason },
    });
  try {
    await save();
  } catch (e) {
    // Two answers at the same moment: the second finds the first's row and updates it.
    if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')) throw e;
    await save();
  }
  await settleNotifications(db, ctx.workspaceId, [missingReceiptSubject(paymentId)]);
}

/** Take the answer back: the payment is checked again (without a second notification). */
export async function withdrawNoReceipt(db: PrismaClient, ctx: NotifyContext, paymentId: string): Promise<void> {
  await db.spendingReceiptAnswer.deleteMany({ where: { authWorkspaceId: ctx.workspaceId, paymentId } });
}

/**
 * Confirm a proposed receipt: the payment is linked to it through the payments
 * service, which checks that the receipt is this company's and not overpaid.
 * Only a receipt the loop proposes right now can be confirmed here.
 */
export async function confirmCandidate(db: PrismaClient, ctx: NotifyContext, paymentId: string, rowId: string): Promise<void> {
  const { states } = await computeStates(db, ctx.workspaceId);
  const state = states.get(paymentId);
  if (!state) throw new LoopServiceError('payment_not_found');
  const candidates: ReceiptCandidate[] = state.state === 'proposed' ? state.candidates : [];
  if (!candidates.some((c) => c.rowId === rowId)) throw new LoopServiceError('not_a_candidate');
  await linkPayment(db, ctx, { paymentId, rowId }, receiptForLink(db, ctx.workspaceId), 'manual');
  await settleNotifications(db, ctx.workspaceId, [missingReceiptSubject(paymentId)]);
}

/**
 * Link a receipt to a payment the owner chose it for (a mail attachment taken
 * over for this payment). The payments service checks that the receipt is
 * this company's and not paid already; the payment must be one still waiting
 * for its receipt.
 */
export async function linkReceiptToPayment(db: PrismaClient, ctx: NotifyContext, paymentId: string, rowId: string): Promise<void> {
  const { states } = await computeStates(db, ctx.workspaceId);
  const state = states.get(paymentId);
  if (!state) throw new LoopServiceError('payment_not_found');
  if (state.state === 'has_receipt') return;
  if (state.state !== 'missing' && state.state !== 'in_mailbox' && state.state !== 'proposed') throw new LoopServiceError('not_a_candidate');
  await linkPayment(db, ctx, { paymentId, rowId }, receiptForLink(db, ctx.workspaceId), 'manual');
  await settleNotifications(db, ctx.workspaceId, [missingReceiptSubject(paymentId), mailFoundSubject(paymentId)]);
}
