import 'server-only';
import { Prisma, type PrismaClient } from '@prisma/client';
import type { MailCandidateView } from '../loop';
import type { NotifyContext } from '../notify/service';
import { MailboxError, searchFor, type MailCandidate, type MailboxPort } from './port';

/**
 * Step 3 against the database: which payments were searched for, what was
 * found, dismissing a wrong find, and finding an attachment again for the
 * download. Every query is scoped to the workspace passed in.
 */

/** Mailbox searches in one run at most: each one is a few calls to the mail service. */
export const MAX_SEARCHES_PER_RUN = 10;
/** The whole mailbox step of a run stops after this long: the import and the button must never wait minutes for mail. */
export const MAILBOX_STEP_BUDGET_MS = 20_000;
/** A search that found nothing is repeated this many times in all, a day apart: invoices often arrive days after the payment. */
export const MAX_SEARCH_TRIES = 3;
export const SEARCH_AGAIN_AFTER_MS = 24 * 60 * 60 * 1000;

export interface PaymentToSearch {
  id: string;
  bookingDay: string;
  amountCents: number;
  /** Names the vendor is known by: the counterparty's normalized name and aliases learned from links. */
  vendorWords: readonly string[];
}

export type MailboxRun =
  /** No mailbox is set up for this company: nothing was searched. */
  | { status: 'off'; missing: string[] }
  | { status: 'ok'; searched: number; found: number }
  /** The mailbox refused or could not be reached; what was searched before is kept, and the failed search is not counted as a try. */
  | { status: 'error'; code: MailboxError['code']; searched: number; found: number };

export async function loadMailCandidates(db: PrismaClient, workspaceId: string): Promise<Map<string, MailCandidateView[]>> {
  const rows = await db.spendingMailCandidate.findMany({ where: { authWorkspaceId: workspaceId, dismissedAt: null }, orderBy: [{ receivedDay: 'desc' }, { partIndex: 'asc' }] });
  const out = new Map<string, MailCandidateView[]>();
  for (const r of rows) {
    const list = out.get(r.paymentId) ?? [];
    list.push({ id: r.id, fileName: r.fileName, receivedDay: r.receivedDay, subject: r.subject, sender: r.sender });
    out.set(r.paymentId, list);
  }
  return out;
}

/** Searches and finds of payments that no longer exist (their import was undone) go with them. */
export async function forgetGonePayments(db: PrismaClient, workspaceId: string): Promise<void> {
  await db.$executeRaw`DELETE FROM spending_mail_candidates c WHERE c.auth_workspace_id = ${workspaceId} AND NOT EXISTS (SELECT 1 FROM tax_payments p WHERE p.id = c.payment_id)`;
  await db.$executeRaw`DELETE FROM spending_mail_searches s WHERE s.auth_workspace_id = ${workspaceId} AND NOT EXISTS (SELECT 1 FROM tax_payments p WHERE p.id = s.payment_id)`;
}

async function recordSearch(db: PrismaClient, ctx: NotifyContext, paymentId: string, outcome: 'found' | 'none' | 'error', now: Date): Promise<void> {
  // A failed search (the mailbox did not answer) does not use up one of the tries.
  const tries = outcome === 'error' ? 0 : 1;
  const write = () =>
    db.spendingMailSearch.upsert({
      where: { authWorkspaceId_paymentId: { authWorkspaceId: ctx.workspaceId, paymentId } },
      create: { authWorkspaceId: ctx.workspaceId, authTenantId: ctx.tenantId, paymentId, outcome, tries, searchedAt: now },
      update: { outcome, tries: { increment: tries }, searchedAt: now },
    });
  try {
    await write();
  } catch (e) {
    // Another run recorded this payment at the same moment: record over it.
    if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')) throw e;
    await write();
  }
}

/**
 * Search the mailbox for the invoices of these payments (the ones whose
 * receipt is missing): each payment once, and again a day later while nothing
 * was found, at most three times; at most ten searches and twenty seconds per
 * run. A payment without a vendor name is not searched (an amount alone finds
 * any mail with that number). A failure of the mailbox stops the run's
 * searches and is reported.
 */
export async function searchMailbox(
  db: PrismaClient,
  ctx: NotifyContext,
  payments: readonly PaymentToSearch[],
  mailbox: MailboxPort,
  now: Date = new Date(),
): Promise<MailboxRun> {
  const status = mailbox.status();
  if (!status.configured) return { status: 'off', missing: status.missing };
  const searchable = payments.flatMap((p) => {
    const query = searchFor(p, p.vendorWords);
    return query ? [{ p, query }] : [];
  });
  const searches = await db.spendingMailSearch.findMany({ where: { authWorkspaceId: ctx.workspaceId, paymentId: { in: searchable.map((s) => s.p.id) } } });
  const byPayment = new Map(searches.map((s) => [s.paymentId, s]));
  const due = searchable.filter(({ p }) => {
    const s = byPayment.get(p.id);
    if (!s) return true;
    return s.outcome !== 'found' && s.tries < MAX_SEARCH_TRIES && s.searchedAt.getTime() < now.getTime() - SEARCH_AGAIN_AFTER_MS;
  });
  const deadline = AbortSignal.timeout(MAILBOX_STEP_BUDGET_MS);
  let searched = 0;
  let found = 0;
  for (const { p, query } of due.slice(0, MAX_SEARCHES_PER_RUN)) {
    if (deadline.aborted) break;
    let mails: MailCandidate[];
    try {
      mails = await mailbox.search(query, deadline);
    } catch (e) {
      const failure = e instanceof MailboxError ? e : new MailboxError('unavailable', e instanceof Error ? e.message : 'error');
      // The time budget ran out: what is left waits for the next run, without a failure.
      if (deadline.aborted) break;
      await recordSearch(db, ctx, p.id, 'error', now);
      console.error('[spending] mailbox search failed', { code: failure.code });
      return { status: 'error', code: failure.code, searched, found };
    }
    searched += 1;
    if (mails.length > 0) {
      await db.spendingMailCandidate.createMany({
        data: mails.map((m) => ({
          authWorkspaceId: ctx.workspaceId,
          authTenantId: ctx.tenantId,
          paymentId: p.id,
          messageId: m.messageId,
          partIndex: m.partIndex,
          fileName: m.fileName.slice(0, 300),
          mimeType: m.mimeType,
          receivedDay: m.receivedDay,
          subject: m.subject.slice(0, 300),
          sender: m.from.slice(0, 300),
        })),
        // A mail found before (also one dismissed as not the invoice) stays as it is.
        skipDuplicates: true,
      });
    }
    // A find counts only when something is left to offer: mails set aside before stay aside.
    const visible = mails.length > 0 && (await db.spendingMailCandidate.count({ where: { authWorkspaceId: ctx.workspaceId, paymentId: p.id, dismissedAt: null } })) > 0;
    if (visible) found += 1;
    await recordSearch(db, ctx, p.id, visible ? 'found' : 'none', now);
  }
  return { status: 'ok', searched, found };
}

/** A found attachment of this workspace, for the download; null when there is none by that id here. */
export async function findMailCandidate(db: PrismaClient, workspaceId: string, id: string) {
  return db.spendingMailCandidate.findFirst({ where: { id, authWorkspaceId: workspaceId, dismissedAt: null } });
}

export class MailCandidateError extends Error {
  readonly code: 'candidate_not_found';
  constructor() {
    super('candidate_not_found');
    this.name = 'MailCandidateError';
    this.code = 'candidate_not_found';
  }
}

/**
 * "Not the invoice": the find is set aside for good (the same mail is never
 * offered again), and the payment may be searched again a day later while it
 * has tries left.
 */
export async function dismissMailCandidate(db: PrismaClient, ctx: NotifyContext, id: string, now: Date = new Date()): Promise<void> {
  const candidate = await findMailCandidate(db, ctx.workspaceId, id);
  if (!candidate) throw new MailCandidateError();
  await db.spendingMailCandidate.updateMany({ where: { id, authWorkspaceId: ctx.workspaceId }, data: { dismissedAt: now } });
  const left = await db.spendingMailCandidate.count({ where: { authWorkspaceId: ctx.workspaceId, paymentId: candidate.paymentId, dismissedAt: null } });
  if (left === 0) await db.spendingMailSearch.updateMany({ where: { authWorkspaceId: ctx.workspaceId, paymentId: candidate.paymentId }, data: { outcome: 'none' } });
}
