'use server';

import { after } from 'next/server';
import { auth } from '@/lib/auth';
import { ReceiptsAuthError, requireReceiptsSession } from '@/lib/auth-guards';
import { MissingTenantError, membershipLabel, requireSessionTenantId, sessionWorkspaceId } from '@/lib/auth-workspace';
import { prisma } from '@/lib/prisma';
import { runSpendingChecks, INTERACTIVE_CLASSIFY_LIMIT } from '@/lib/spending/checks';
import { settleAcrossShares } from '@/lib/spending/loop-service';
import { berlinToday } from '@/lib/spending/period';
import { ShareError, endShare, loadShares, shareAccount, type ShareView } from '@/lib/tax/payments/routing';
import type { Result } from './actions';

/**
 * Server actions for sharing an account's private payments with another
 * company of the same person (plan
 * docs/plans/2026-10-22-payments-across-companies.md). The account is always
 * one of the session's ACTIVE company. Starting a share needs the write
 * permission in BOTH companies, and the target must be one of the person's own
 * memberships: a company the person is not a member of is refused as
 * forbidden, never looked up. Ending a share needs the write permission in
 * either company. Either way, the message queues of both companies are
 * settled after the answer, so a message about a payment that moved never
 * stays in the company it left.
 */

type Session = Awaited<ReturnType<typeof requireReceiptsSession>>;

export interface ShareEntry extends ShareView {
  /** The other company's name as this person knows it; null when the person is no member of it any more. */
  otherName: string | null;
}

export interface SharingView {
  /** This company's accounts whose private payments go to another company. */
  outgoing: ShareEntry[];
  /** Other companies' accounts whose private payments come here. */
  incoming: ShareEntry[];
  /** The person's other companies, to share with. Whether the person may write there is checked when sharing. */
  targets: Array<{ workspaceId: string; label: string }>;
  canWrite: boolean;
}

function failure(e: unknown): { ok: false; error: 'unauthorized' | 'forbidden' | 'not_found' | 'invalid_input' | 'failed'; detail?: string } {
  if (e instanceof ReceiptsAuthError) return { ok: false, error: e.status === 401 ? 'unauthorized' : e.status === 404 ? 'not_found' : 'forbidden' };
  const status = (e as { status?: number })?.status;
  if (status === 401) return { ok: false, error: 'unauthorized' };
  if (status === 403 || e instanceof MissingTenantError) return { ok: false, error: 'forbidden' };
  if (e instanceof ShareError) {
    const missing = e.code === 'account_not_found' || e.code === 'share_not_found';
    return { ok: false, error: missing ? 'not_found' : 'invalid_input', detail: e.code };
  }
  console.error('[finance] sharing action failed', (e as Error)?.name ?? 'error');
  return { ok: false, error: 'failed' };
}

function nameOf(session: Session, workspaceId: string): string | null {
  const membership = session.memberships.find((m) => m.id === workspaceId);
  return membership ? membershipLabel(membership, session.memberships) : null;
}

async function sharingView(session: Session, workspaceId: string, canWrite: boolean): Promise<SharingView> {
  const { outgoing, incoming } = await loadShares(prisma, workspaceId);
  const entry = (s: ShareView): ShareEntry => ({ ...s, otherName: nameOf(session, s.otherWorkspaceId) });
  const seen = new Set<string>([workspaceId]);
  const targets: SharingView['targets'] = [];
  for (const m of session.memberships) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    targets.push({ workspaceId: m.id, label: membershipLabel(m, session.memberships) });
  }
  targets.sort((a, b) => a.label.localeCompare(b.label, 'de'));
  return { outgoing: outgoing.map(entry), incoming: incoming.map(entry), targets, canWrite };
}

export async function getSharingView(): Promise<Result<SharingView>> {
  try {
    const session = await requireReceiptsSession();
    // Fail closed: any doubt about the permission shows the section read-only.
    const canWrite = await auth.requireAction('receipts.row.write').then(
      () => true,
      () => false,
    );
    return { ok: true, value: await sharingView(session, sessionWorkspaceId(session), canWrite) };
  } catch (e) {
    return failure(e);
  }
}

/**
 * Share the private payments of an account of the active company with another
 * company of the person. Afterwards the receiving company's spending checks
 * run once (after the answer), so recent private payments are asked about
 * there.
 */
export async function shareAccountWith(accountId: unknown, targetWorkspaceId: unknown): Promise<Result<SharingView>> {
  try {
    const session = await auth.requireAction('receipts.row.write');
    const workspaceId = sessionWorkspaceId(session);
    if (typeof accountId !== 'string' || !accountId) return { ok: false, error: 'not_found', detail: 'account_not_found' };
    // Only a company of the person's own: anything else is forbidden, whatever it is.
    if (typeof targetWorkspaceId !== 'string' || !session.memberships.some((m) => m.id === targetWorkspaceId)) return { ok: false, error: 'forbidden' };
    if (targetWorkspaceId === workspaceId) return { ok: false, error: 'invalid_input', detail: 'same_company' };
    // The write permission in the receiving company too: its spending side changes.
    await auth.requireAction('receipts.row.write', targetWorkspaceId);
    const holder = { workspaceId, tenantId: requireSessionTenantId(session, workspaceId) };
    const receiver = { workspaceId: targetWorkspaceId, tenantId: requireSessionTenantId(session, targetWorkspaceId) };
    await shareAccount(prisma, holder, accountId, receiver, session.userId);
    // After the answer: the payments that moved leave the holder's message queue, and the receiver's checks run once.
    after(async () => {
      await settleAcrossShares(prisma, [workspaceId, receiver.workspaceId]);
      try {
        await runSpendingChecks(prisma, receiver, { today: berlinToday(), classifyLimit: INTERACTIVE_CLASSIFY_LIMIT });
      } catch (e) {
        console.error('[finance] spending checks after sharing failed', (e as Error)?.name ?? 'error');
      }
    });
    return { ok: true, value: await sharingView(session, workspaceId, true) };
  } catch (e) {
    return failure(e);
  }
}

/** End a share, from the company that holds the account or the one that receives its private payments. */
export async function endAccountShare(shareId: unknown): Promise<Result<SharingView>> {
  try {
    const session = await auth.requireAction('receipts.row.write');
    const workspaceId = sessionWorkspaceId(session);
    if (typeof shareId !== 'string' || !shareId) return { ok: false, error: 'not_found', detail: 'share_not_found' };
    const { holder, receiver } = await endShare(prisma, workspaceId, shareId);
    // After the answer: messages about the payments that went back to the holder leave the receiver's queue at once.
    after(() => settleAcrossShares(prisma, [holder.workspaceId, receiver.workspaceId]));
    return { ok: true, value: await sharingView(session, workspaceId, true) };
  } catch (e) {
    return failure(e);
  }
}
