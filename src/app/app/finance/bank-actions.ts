'use server';

import { headers } from 'next/headers';
import { after } from 'next/server';
import { auth } from '@/lib/auth';
import { ReceiptsAuthError, requireReceiptsSession } from '@/lib/auth-guards';
import { MissingTenantError, requireSessionTenantId, sessionWorkspaceId } from '@/lib/auth-workspace';
import { prisma } from '@/lib/prisma';
import { runSpendingChecks } from '@/lib/spending/checks';
import { berlinToday } from '@/lib/spending/period';
import { bankConfig } from '@/lib/tax/payments/bank/config';
import { serverBankDeps } from '@/lib/tax/payments/bank/server';
import {
  BankServiceError,
  chooseBankAccount,
  disconnect,
  listInstitutions,
  loadBankConnections,
  startConsent,
  syncConnection,
  type BankConnectionView,
  type SyncOutcome,
} from '@/lib/tax/payments/bank/service';
import type { PaymentContext } from '@/lib/tax/payments/service';
import { loadStatement, type StatementView } from '@/lib/tax/service';
import type { Result } from './actions';

/**
 * Server actions of the live bank connection (payments tab). Like the other
 * finance actions they re-resolve the verified session, act only in its
 * ACTIVE company, and return failures with a stable code. With the bank feed
 * switched off every write refuses with `feature_off`.
 */

export interface BankView {
  /** False when the server has the bank feed switched off or its settings are incomplete. */
  enabled: boolean;
  connections: BankConnectionView[];
}

export interface Institution {
  name: string;
  country: string;
  beta: boolean;
}

function failure(e: unknown): { ok: false; error: 'unauthorized' | 'forbidden' | 'not_found' | 'invalid_input' | 'failed'; detail?: string } {
  if (e instanceof ReceiptsAuthError) return { ok: false, error: e.status === 401 ? 'unauthorized' : e.status === 404 ? 'not_found' : 'forbidden' };
  const status = (e as { status?: number })?.status;
  if (status === 401) return { ok: false, error: 'unauthorized' };
  if (status === 403 || e instanceof MissingTenantError) return { ok: false, error: 'forbidden' };
  if (e instanceof BankServiceError) {
    const missing = e.code === 'account_not_found' || e.code === 'connection_not_found';
    return { ok: false, error: missing ? 'not_found' : 'invalid_input', detail: e.detail ? `${e.code}:${e.detail}` : e.code };
  }
  console.error('[bank] action failed', (e as Error)?.name ?? 'error');
  return { ok: false, error: 'failed' };
}

const OFF = { ok: false as const, error: 'invalid_input' as const, detail: 'feature_off' };

async function writeContext(): Promise<PaymentContext> {
  const session = await auth.requireAction('receipts.row.write');
  const workspaceId = sessionWorkspaceId(session);
  return { workspaceId, tenantId: requireSessionTenantId(session, workspaceId) };
}

async function bankView(workspaceId: string): Promise<BankView> {
  return { enabled: bankConfig().enabled, connections: await loadBankConnections(prisma, workspaceId) };
}

export async function getBankView(): Promise<Result<BankView>> {
  try {
    const session = await requireReceiptsSession();
    return { ok: true, value: await bankView(sessionWorkspaceId(session)) };
  } catch (e) {
    return failure(e);
  }
}

// The institutions change rarely; asking the interface once per hour is enough.
let institutionCache: { at: number; list: Institution[] } | null = null;
const INSTITUTION_CACHE_MS = 60 * 60_000;

/** The institutions the interface offers for Germany, read at run time (the list is only available signed). */
export async function listBankInstitutions(): Promise<Result<Institution[]>> {
  try {
    await requireReceiptsSession();
    const deps = serverBankDeps();
    if (!deps) return OFF;
    if (institutionCache && Date.now() - institutionCache.at < INSTITUTION_CACHE_MS) return { ok: true, value: institutionCache.list };
    const list = (await listInstitutions(deps, 'DE')).map((a) => ({ name: a.name, country: a.country, beta: a.beta }));
    institutionCache = { at: Date.now(), list };
    return { ok: true, value: list };
  } catch (e) {
    return failure(e);
  }
}

/** Start (or renew) the consent of an account at the chosen institution; the browser then goes to `url`. */
export async function startBankConsent(accountId: string, institution: unknown): Promise<Result<{ url: string }>> {
  try {
    const ctx = await writeContext();
    const deps = serverBankDeps();
    if (!deps) return OFF;
    return { ok: true, value: await startConsent(prisma, ctx, deps, String(accountId), institution) };
  } catch (e) {
    return failure(e);
  }
}

/** Bind one account of the bank's session, or switch to another one of it. */
export async function chooseBankConnectionAccount(connectionId: string, uid: unknown): Promise<Result<BankView>> {
  try {
    const ctx = await writeContext();
    if (!serverBankDeps()) return OFF;
    await chooseBankAccount(prisma, ctx, String(connectionId), uid);
    return { ok: true, value: await bankView(ctx.workspaceId) };
  } catch (e) {
    return failure(e);
  }
}

/** "Jetzt abholen": fetch one connection now, while the person is present. */
export async function syncBankNow(year: number, connectionId: string): Promise<Result<{ bank: BankView; view: StatementView; outcome: SyncOutcome }>> {
  try {
    const ctx = await writeContext();
    const deps = serverBankDeps();
    if (!deps) return OFF;
    const today = berlinToday();
    // The person is present: say so to the bank, so this fetch does not use up the few unattended ones a day.
    const h = await headers();
    // The address the edge network saw first (it overwrites what a browser sends), then the proxy's.
    const ipAddress = (h.get('cf-connecting-ip') ?? h.get('x-real-ip') ?? (h.get('x-forwarded-for') ?? '').split(',')[0]).trim();
    // Header values must be plain text: anything else would make the request itself fail.
    const userAgent = (h.get('user-agent') ?? '').replace(/[^\x20-\x7E]/g, '').trim();
    const psu = ipAddress && userAgent ? { ipAddress, userAgent } : undefined;
    const outcome = await syncConnection(prisma, ctx, deps, String(connectionId), { today, psu });
    if (outcome.added > 0) {
      // The missing-receipt loop and the budget warnings run on what arrived, after the answer is sent.
      after(async () => {
        try {
          await runSpendingChecks(prisma, ctx, { today });
        } catch (e) {
          console.error('[bank] spending checks after the bank fetch failed', (e as Error)?.name ?? 'error');
        }
      });
    }
    const safe = Number.isInteger(year) ? year : new Date().getFullYear();
    return { ok: true, value: { bank: await bankView(ctx.workspaceId), view: await loadStatement(prisma, ctx.workspaceId, safe), outcome } };
  } catch (e) {
    return failure(e);
  }
}

/** End the connection of an account; its payments stay. */
export async function disconnectBank(connectionId: string): Promise<Result<{ bank: BankView; closedAtBank: boolean }>> {
  try {
    const ctx = await writeContext();
    const deps = serverBankDeps();
    if (!deps) return OFF;
    const { closedAtBank } = await disconnect(prisma, ctx, deps, String(connectionId));
    return { ok: true, value: { bank: await bankView(ctx.workspaceId), closedAtBank } };
  } catch (e) {
    return failure(e);
  }
}
