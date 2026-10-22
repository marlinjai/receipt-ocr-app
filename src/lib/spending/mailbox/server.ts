import 'server-only';
import type { PrismaClient } from '@prisma/client';
import { receivesFrom } from '@/lib/tax/payments/routing';
import { serverMailbox } from './gmail';
import type { MailboxPort } from './port';

/**
 * The expenses mailbox as one company may use it. It belongs to the company in
 * `SPENDING_MAILBOX_WORKSPACE_ID`, and it also serves every company that
 * receives the private payments of one of that company's accounts (plan
 * docs/plans/2026-10-22-payments-across-companies.md): before the split those
 * payments were searched for there, and the share is the owner's statement
 * that they are his. For every other company it is off. Searches and finds are
 * stored per company, so each one sees only the finds of its own payments.
 */
export async function mailboxFor(db: PrismaClient, workspaceId: string, env: Record<string, string | undefined> = process.env): Promise<MailboxPort> {
  const owner = env.SPENDING_MAILBOX_WORKSPACE_ID?.trim();
  if (owner && owner !== workspaceId && (await receivesFrom(db, workspaceId, owner))) return serverMailbox(owner, env);
  return serverMailbox(workspaceId, env);
}
