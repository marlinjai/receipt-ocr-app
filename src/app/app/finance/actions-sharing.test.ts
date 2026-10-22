import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The finance actions' part in payments across companies (plan
 * docs/plans/2026-10-22-payments-across-companies.md): after an answer, a link
 * or an undone import that touches a shared account, the message queues of
 * the holder and its receivers are settled after the answer; after an import
 * the spending checks run for the receivers too. Session, services and
 * database are stand-ins; a failure of the settling never fails the action.
 */

const s = vi.hoisted(() => ({
  setCounterpartyTreatment: vi.fn(),
  setPaymentKind: vi.fn(),
  setPaymentTransfer: vi.fn(),
  setAccountPrivate: vi.fn(),
  linkPayment: vi.fn(),
  unlinkPayment: vi.fn(),
  deleteImportBatch: vi.fn(),
  importPayments: vi.fn(),
  loadStatement: vi.fn(),
  touchesSharedAccount: vi.fn(),
  settleAcrossSharesCoalesced: vi.fn(),
  runSpendingChecksAfterNewPayments: vi.fn(),
}));

vi.mock('next/server', () => ({ after: async (fn: () => unknown) => fn() }));
vi.mock('@/lib/auth', () => ({ auth: { requireAction: vi.fn(async () => ({ memberships: [] })) } }));
vi.mock('@/lib/auth-workspace', async (original) => ({
  ...(await original<typeof import('@/lib/auth-workspace')>()),
  sessionWorkspaceId: () => 'ws-1',
  requireSessionTenantId: () => 'tenant-1',
}));
vi.mock('@/lib/prisma', () => ({ prisma: { marker: 'prisma' } }));
vi.mock('@/lib/tax/service', async (original) => ({ ...(await original<typeof import('@/lib/tax/service')>()), loadStatement: s.loadStatement, receiptForLink: () => async () => null }));
vi.mock('@/lib/tax/payments/service', async (original) => ({
  ...(await original<typeof import('@/lib/tax/payments/service')>()),
  setCounterpartyTreatment: s.setCounterpartyTreatment,
  setPaymentKind: s.setPaymentKind,
  setPaymentTransfer: s.setPaymentTransfer,
  setAccountPrivate: s.setAccountPrivate,
  linkPayment: s.linkPayment,
  unlinkPayment: s.unlinkPayment,
  deleteImportBatch: s.deleteImportBatch,
  importPayments: s.importPayments,
}));
vi.mock('@/lib/tax/payments/routing', () => ({ touchesSharedAccount: s.touchesSharedAccount }));
vi.mock('@/lib/spending/loop-service', () => ({ settleAcrossSharesCoalesced: s.settleAcrossSharesCoalesced }));
vi.mock('@/lib/spending/checks', () => ({ runSpendingChecksAfterNewPayments: s.runSpendingChecksAfterNewPayments }));

import { confirmPaymentLink, correctPaymentKind, importPaymentFile, markAccountPrivate, markPaymentTransfer, removePaymentLink, treatCounterparty, undoImport } from './actions';

const CTX = { workspaceId: 'ws-1', tenantId: 'tenant-1' };

beforeEach(() => {
  for (const fn of Object.values(s)) fn.mockReset();
  s.loadStatement.mockResolvedValue({ year: 2026 });
  s.linkPayment.mockResolvedValue({ linkId: 'l1', movedFromPaymentId: null });
  s.importPayments.mockResolvedValue({ added: 1 });
  s.touchesSharedAccount.mockResolvedValue(true);
  s.settleAcrossSharesCoalesced.mockResolvedValue(undefined);
});

describe('settling after a change in a holder', () => {
  it('passes what the change touched, so only a shared account starts the settling', async () => {
    await treatCounterparty(2026, { counterparty: 'Laden', treatment: 'private' });
    expect(s.touchesSharedAccount).toHaveBeenLastCalledWith({ marker: 'prisma' }, 'ws-1', { counterparty: 'Laden' });
    await correctPaymentKind(2026, 'p1', 'private');
    expect(s.touchesSharedAccount).toHaveBeenLastCalledWith({ marker: 'prisma' }, 'ws-1', { paymentId: 'p1' });
    await markPaymentTransfer(2026, 'p2', true);
    expect(s.touchesSharedAccount).toHaveBeenLastCalledWith({ marker: 'prisma' }, 'ws-1', { paymentId: 'p2' });
    await markAccountPrivate(2026, 'a1', true);
    expect(s.touchesSharedAccount).toHaveBeenLastCalledWith({ marker: 'prisma' }, 'ws-1', { accountId: 'a1' });
    await confirmPaymentLink(2026, { paymentId: 'p3', rowId: 'r1' });
    expect(s.touchesSharedAccount).toHaveBeenLastCalledWith({ marker: 'prisma' }, 'ws-1', { paymentId: 'p3' });
    await removePaymentLink(2026, 'l1');
    expect(s.touchesSharedAccount).toHaveBeenLastCalledWith({ marker: 'prisma' }, 'ws-1', {});
    await undoImport(2026, 'b1');
    expect(s.touchesSharedAccount).toHaveBeenLastCalledWith({ marker: 'prisma' }, 'ws-1', {});
    expect(s.settleAcrossSharesCoalesced).toHaveBeenCalledTimes(7);
    expect(s.settleAcrossSharesCoalesced).toHaveBeenLastCalledWith({ marker: 'prisma' }, ['ws-1'], { onlyWithReceivers: true });
  });

  it('settles nothing when no shared account is touched', async () => {
    s.touchesSharedAccount.mockResolvedValue(false);
    expect((await treatCounterparty(2026, { counterparty: 'Laden', treatment: 'business' })).ok).toBe(true);
    expect(s.settleAcrossSharesCoalesced).not.toHaveBeenCalled();
  });

  it('a failing settling is logged and never fails the answer', async () => {
    s.settleAcrossSharesCoalesced.mockRejectedValue(new Error('database gone'));
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await treatCounterparty(2026, { counterparty: 'Laden', treatment: 'private' })).toEqual({ ok: true, value: { year: 2026 } });
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });

  it('a refused answer settles nothing', async () => {
    s.setPaymentKind.mockRejectedValue(new Error('refused'));
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await correctPaymentKind(2026, 'p1', 'private')).ok).toBe(false);
    expect(s.touchesSharedAccount).not.toHaveBeenCalled();
    log.mockRestore();
  });
});

describe('after an import', () => {
  it('runs the spending checks for the company and the companies receiving its private payments', async () => {
    await importPaymentFile(2026, 'a1', 'text');
    expect(s.runSpendingChecksAfterNewPayments).toHaveBeenCalledWith({ marker: 'prisma' }, CTX, expect.objectContaining({ today: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) }));
  });
});
