import 'server-only';
import { Prisma, type PrismaClient } from '@prisma/client';
import { allReceiptRows, tableContext } from '@/lib/meals/service';
import { rowToMealRecord } from '@/lib/meals/record';
import { vendorKey } from '@/lib/tax/decisions';
import { eurosToCents, formatCents } from '@/lib/tax/money';
import { linkPayment, type PaymentRow } from '@/lib/tax/payments/service';
import { linkRoutedPayment, loadRoutedPayments, paymentOnSpendingSide, receiversOf, type RoutedPaymentRow } from '@/lib/tax/payments/routing';
import { receiptForLink } from '@/lib/tax/service';
import { categoryAnswerMap } from './service';
import { loopState, mailFoundSubject, missingReceiptSubject, notifiable, type LoopContext, type LoopReceipt, type LoopState, type NotNeededReason, type ReceiptCandidate } from './loop';
import { notify, retryFailedDeliveries, serverChannels, settleAllBut, settleNotifications, type NotifyContext } from './notify/service';
import type { NotificationChannel } from './notify/port';
import { mailboxFor } from './mailbox/server';
import { mailWordsFor, type MailboxPort } from './mailbox/port';
import { spendingPath } from './paths';
import { forgetGonePayments, loadMailCandidates, searchMailbox, type MailboxRun } from './mailbox/service';

/**
 * The missing-receipt loop against the database: what it reads, the open
 * checks it shows, the answers a person gives, and the run that notifies.
 * Every function takes the workspace explicitly; receipts and payments are
 * only ever matched within one company. The payments are the spending side's
 * (`loadRoutedPayments`): a private payment of an account another company
 * holds and shares with this one is asked about here, and never there.
 */

export type LoopServiceErrorCode =
  | 'payment_not_found'
  | 'reason_required'
  | 'not_a_candidate'
  /** The "no receipt" answer was given in the company that holds the account; it is taken back there. */
  | 'answered_by_holder';

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
  payments: RoutedPaymentRow[];
  /** This company's own payments routed to another company, with the "no receipt" answer it gave before, if any. */
  routedAwayAnswered: Array<{ payment: PaymentRow; reason: string }>;
  states: Map<string, LoopState>;
  /** Vendor keys each counterparty stands for, learned from links: the names a mailbox search uses besides the counterparty's own. */
  aliases: Map<string, Set<string>>;
}

async function computeStates(db: PrismaClient, workspaceId: string): Promise<Loaded> {
  const [loaded, noReceipt, mailCandidates] = await Promise.all([
    loadRoutedPayments(db, workspaceId),
    db.spendingReceiptAnswer.findMany({ where: { authWorkspaceId: workspaceId } }),
    loadMailCandidates(db, workspaceId),
  ]);
  // "No receipt exists", said in the holding company before the payment was routed here, still holds.
  // Never the other way: what this company says stays here.
  const routedIds = loaded.payments.filter((p) => p.routedFrom !== null).map((p) => p.id);
  const inherited =
    routedIds.length === 0 ? [] : await db.spendingReceiptAnswer.findMany({ where: { authWorkspaceId: { in: loaded.holders }, paymentId: { in: routedIds } } });
  const reasons = new Map(inherited.map((a) => [a.paymentId, a.reason]));
  const fromHolder = new Set(inherited.map((a) => a.paymentId));
  for (const a of noReceipt) {
    reasons.set(a.paymentId, a.reason);
    fromHolder.delete(a.paymentId);
  }
  // A receipt of this company linked to any payment, also one that moved back to the company holding its
  // account (that link counts nowhere now, but it is the receipt's payment): never proposed for another one.
  const linkedRows = new Set([...loaded.payments.flatMap((p) => p.links.flatMap((l) => (l.rowId ? [l.rowId] : []))), ...loaded.linkedElsewhere.keys()]);
  const receipts = await loadLoopReceipts(db, workspaceId, linkedRows);
  const aliases = vendorAliases(loaded.payments, receipts);
  const ctx: LoopContext = {
    treatments: loaded.treatments,
    categoryAnswers: await categoryAnswerMap(db, workspaceId, loaded),
    noReceipt: reasons,
    noReceiptFromHolder: fromHolder,
    receipts,
    vendorAliases: aliases,
    mailCandidates,
  };
  const states = new Map<string, LoopState>();
  for (const p of loaded.payments) {
    states.set(p.id, loopState({ ...p, linkCount: p.links.length }, ctx));
  }
  const ownReasons = new Map(noReceipt.map((a) => [a.paymentId, a.reason]));
  const routedAwayAnswered = loaded.routedAway.flatMap((p) => (ownReasons.has(p.id) ? [{ payment: p, reason: ownReasons.get(p.id) as string }] : []));
  return { payments: loaded.payments, states, aliases, routedAwayAnswered };
}

/** The subjects of the payments still waiting for their receipt: what keeps its messages in the in-app queue. */
function openSubjects(payments: readonly PaymentRow[], states: ReadonlyMap<string, LoopState>): { waiting: PaymentRow[]; inMailbox: Set<string>; open: number; stillOpen: Set<string> } {
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
  const stillOpen = new Set(waiting.flatMap((p) => [missingReceiptSubject(p.id), ...(inMailbox.has(p.id) ? [mailFoundSubject(p.id)] : [])]));
  return { waiting, inMailbox, open, stillOpen };
}

/**
 * Take out of the in-app queue every message about a payment that no longer
 * waits here: it got its receipt, needs none, or moved to another company (an
 * account shared or no longer shared, an answer changed in the company that
 * holds it). Sends nothing. Returns how many messages went.
 */
export async function settleMovedPayments(db: PrismaClient, workspaceId: string): Promise<number> {
  const { payments, states } = await computeStates(db, workspaceId);
  return settleAllBut(db, workspaceId, 'missing_receipt', openSubjects(payments, states).stillOpen);
}

/** Settling under way per set of companies, so a burst of answers settles once more at the end instead of once per click. */
const settling = new Map<string, { again: boolean; done: Promise<void> }>();

/**
 * `settleAcrossShares`, coalesced within this server process: while a settling
 * of the same companies runs, further calls only ask for one more run after
 * it. A person answering ten counterparties in a row starts two runs, not ten.
 */
export function settleAcrossSharesCoalesced(db: PrismaClient, workspaceIds: readonly string[], options: { onlyWithReceivers?: boolean } = {}): Promise<void> {
  const key = [...workspaceIds].sort().join('|');
  const running = settling.get(key);
  if (running) {
    running.again = true;
    return running.done;
  }
  const entry = { again: false, done: Promise.resolve() };
  entry.done = (async () => {
    try {
      do {
        entry.again = false;
        await settleAcrossShares(db, workspaceIds, options);
      } while (entry.again);
    } finally {
      settling.delete(key);
    }
  })();
  settling.set(key, entry);
  return entry.done;
}

/**
 * `settleMovedPayments` for a company that holds accounts and for every
 * company receiving private payments of them: after a share started or ended
 * and after an answer changed in the holder, a message about a payment that
 * left a company leaves its queue at once. A failure is logged only: the next
 * run of the loop settles the same messages.
 */
export async function settleAcrossShares(db: PrismaClient, workspaceIds: readonly string[], options: { onlyWithReceivers?: boolean } = {}): Promise<void> {
  let receivers: Awaited<ReturnType<typeof receiversOf>> = [];
  try {
    receivers = await receiversOf(db, workspaceIds);
  } catch (e) {
    console.error('[spending] the companies receiving private payments could not be read', (e as Error)?.name ?? 'error');
    if (options.onlyWithReceivers) return;
  }
  // After an answer in a company that shares no account, nothing can have moved between companies.
  if (options.onlyWithReceivers && receivers.length === 0) return;
  const all = new Set(workspaceIds);
  for (const r of receivers) all.add(r.workspaceId);
  for (const workspaceId of all) {
    // Each company on its own: one failing never keeps the other's queue stale.
    try {
      await settleMovedPayments(db, workspaceId);
    } catch (e) {
      console.error('[spending] settling messages of moved payments failed', (e as Error)?.name ?? 'error');
    }
  }
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
  const { payments, states, routedAwayAnswered } = await computeStates(db, workspaceId);
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
  // A "no receipt" answer given here about a payment now routed to another company stays visible here, so
  // it can be taken back where it was given (the other company shows it as answered here).
  for (const { payment, reason } of routedAwayAnswered) answered.push(check(payment, { state: 'no_receipt', reason, movedAway: true }));
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
  const mailbox = await searchMailbox(db, ctx, lookFor, options.mailbox ?? (await mailboxFor(db, ctx.workspaceId)), options.now);
  if (mailbox.status !== 'off' && mailbox.found > 0) ({ payments, states, aliases } = await computeStates(db, ctx.workspaceId));
  const { waiting, inMailbox, open, stillOpen } = openSubjects(payments, states);
  // In this order: what is settled (or gone with an undone import, or moved to another company) leaves
  // the queue and is never retried, earlier failed deliveries are tried again, and only then are new
  // ones sent, so a notification created in this run is not tried twice in it.
  const settled = await settleAllBut(db, ctx.workspaceId, 'missing_receipt', stillOpen);
  const retried = await retryFailedDeliveries(db, ctx.workspaceId, channels, options.now);
  let notified = 0;
  let deferred = 0;
  // One message per payment and kind: "receipt missing", and "invoice in the mailbox" once it is found
  // (also when that happens on a later search, after the first message).
  const subjectOf = (p: PaymentRow) => (inMailbox.has(p.id) ? mailFoundSubject(p.id) : missingReceiptSubject(p.id));
  const recent = waiting.filter((p) => notifiable(p, options.today));
  // Payments notified about before are done for good: only the rest count towards the limit. A subject
  // names its payment, whose id is unique in the whole database, so it is looked up in every company
  // (only whether a message exists, never what it says): a payment that moved here from another company
  // (a changed answer, a share started or ended) is never announced a second time.
  const notifiedBefore = new Set(
    (
      await db.spendingNotification.findMany({
        where: { kind: 'missing_receipt', subjectKey: { in: recent.map(subjectOf) } },
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
    // At most once in the whole database: the subject names the payment, which may have moved between companies.
    if ((await notify(db, ctx, { subjectKey: subjectOf(p), kind: 'missing_receipt', ...message }, channels, { acrossCompanies: true })) === 'sent') notified += 1;
  }
  return { notified, deferred, settled, retried, open, mailbox };
}

/** The payment must be on this company's spending side: its own and not routed away, or routed here. */
async function requirePayment(db: PrismaClient, workspaceId: string, paymentId: string): Promise<void> {
  if (typeof paymentId !== 'string' || !paymentId || !(await paymentOnSpendingSide(db, workspaceId, paymentId))) throw new LoopServiceError('payment_not_found');
}

/** Link a receipt of this company to a payment of its spending side: through the payments service for its own, as a receiver's link for a routed one. */
async function linkOnSpendingSide(db: PrismaClient, ctx: NotifyContext, payment: RoutedPaymentRow, rowId: string): Promise<void> {
  if (payment.routedFrom !== null) await linkRoutedPayment(db, ctx, payment.id, rowId, receiptForLink(db, ctx.workspaceId));
  else await linkPayment(db, ctx, { paymentId: payment.id, rowId }, receiptForLink(db, ctx.workspaceId), 'manual');
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
  const { count } = await db.spendingReceiptAnswer.deleteMany({ where: { authWorkspaceId: ctx.workspaceId, paymentId } });
  if (count > 0) return;
  // Nothing of this company's to take back: an answer of the holding company still shows here, and is changed there.
  const { states } = await computeStates(db, ctx.workspaceId);
  const state = states.get(paymentId);
  if (state?.state === 'no_receipt' && state.fromHolder) throw new LoopServiceError('answered_by_holder');
}

/**
 * Confirm a proposed receipt: the payment is linked to it through the payments
 * service, which checks that the receipt is this company's and not overpaid.
 * Only a receipt the loop proposes right now can be confirmed here.
 */
export async function confirmCandidate(db: PrismaClient, ctx: NotifyContext, paymentId: string, rowId: string): Promise<void> {
  const { states, payments } = await computeStates(db, ctx.workspaceId);
  const state = states.get(paymentId);
  const payment = payments.find((p) => p.id === paymentId);
  if (!state || !payment) throw new LoopServiceError('payment_not_found');
  const candidates: ReceiptCandidate[] = state.state === 'proposed' ? state.candidates : [];
  if (!candidates.some((c) => c.rowId === rowId)) throw new LoopServiceError('not_a_candidate');
  await linkOnSpendingSide(db, ctx, payment, rowId);
  await settleNotifications(db, ctx.workspaceId, [missingReceiptSubject(paymentId)]);
}

/**
 * Link a receipt to a payment the owner chose it for (a mail attachment taken
 * over for this payment). The payments service checks that the receipt is
 * this company's and not paid already; the payment must be one still waiting
 * for its receipt.
 */
export async function linkReceiptToPayment(db: PrismaClient, ctx: NotifyContext, paymentId: string, rowId: string): Promise<void> {
  const { states, payments } = await computeStates(db, ctx.workspaceId);
  const state = states.get(paymentId);
  const payment = payments.find((p) => p.id === paymentId);
  if (!state || !payment) throw new LoopServiceError('payment_not_found');
  if (state.state === 'has_receipt') return;
  if (state.state !== 'missing' && state.state !== 'in_mailbox' && state.state !== 'proposed') throw new LoopServiceError('not_a_candidate');
  await linkOnSpendingSide(db, ctx, payment, rowId);
  await settleNotifications(db, ctx.workspaceId, [missingReceiptSubject(paymentId), mailFoundSubject(paymentId)]);
}
