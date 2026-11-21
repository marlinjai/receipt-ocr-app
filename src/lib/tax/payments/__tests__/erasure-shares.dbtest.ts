import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createAccount, importPayments, loadPayments, setCounterpartyTreatment } from '../service';
import { endCompanyAccountShares, shareAccount } from '../routing';
import { confirmCandidate } from '@/lib/spending/loop-service';
import { eraseCompany, type CompanyErasureDeps } from '@/lib/company-erasure';
import { contactsDb } from '@/lib/contacts/db';
import { createWorkspace, db } from '../../../../../test/db-helpers';
import { ensureContactsLayout } from '../../../../../test/contacts-db';

/**
 * The whole company erasure on two companies that share an account (plan
 * docs/plans/2026-10-22-payments-across-companies.md): the holder's private
 * payments go to the receiver, and the receiver linked one of its receipts to
 * one of them. The erasure checks the stamps before it ends the share, so this
 * shows that a share is not mistaken for another company's rows, and that the
 * company that is not erased keeps its own records. Every name is invented.
 */

const HEADER = '"Booking Date","Value Date","Partner Name","Partner Iban",Type,"Payment Reference","Account Name","Amount (EUR)","Original Amount","Original Currency","Exchange Rate"';
const line = (day: string, partner: string, reference: string, amount: string) => `${day},${day},"${partner}",,Presentment,"${reference}",Hauptkonto,${amount},,,`;

beforeAll(async () => {
  await ensureContactsLayout();
});

afterAll(async () => {
  await contactsDb().close();
  await db.$disconnect();
});

async function sharedWorld() {
  const [holder, receiver] = await Promise.all([createWorkspace(), createWorkspace()]);
  const hctx = { workspaceId: holder.workspaceId, tenantId: holder.tenantId };
  const rctx = { workspaceId: receiver.workspaceId, tenantId: receiver.tenantId };
  const accountId = await createAccount(db, hctx, { label: 'Girokonto', kind: 'bank' });
  await importPayments(db, hctx, accountId, [HEADER, line('2026-05-10', 'Privat Laden', 'Einkauf', '-20.00'), line('2026-05-11', 'Firma Software', 'Abo', '-50.00')].join('\n') + '\n');
  await setCounterpartyTreatment(db, hctx, { counterparty: 'Privat Laden', treatment: 'private' });
  await setCounterpartyTreatment(db, hctx, { counterparty: 'Firma Software', treatment: 'business' });
  await shareAccount(db, hctx, accountId, rctx, 'user-owner');
  const { payments } = await loadPayments(db, hctx.workspaceId);
  const privateId = payments.find((p) => p.counterparty === 'Privat Laden')!.id;
  // The receiver ties one of its own receipts to the holder's private payment.
  const receiverRow = await receiver.addReceipt({ Name: 'Privat Laden Bon', Vendor: 'Privat Laden', Gross: 20, Date: '2026-05-10', Currency: 'EUR', 'FX Rate': 1 });
  await confirmCandidate(db, rctx, privateId, receiverRow);
  const holderRow = await holder.addReceipt({ Name: 'Software Rechnung', Vendor: 'Firma Software', Gross: 50, Date: '2026-05-11', Currency: 'EUR', 'FX Rate': 1 });
  return { holder, receiver, hctx, rctx, accountId, receiverRow, holderRow };
}

function deps(): CompanyErasureDeps {
  return {
    deleteStoredFile: vi.fn(async () => {}),
    endBankConnections: async () => ({ connections: 0, sessionsLeftOpen: 0 }),
    // The real ending of shares, as the route wires it.
    endAccountShares: (tenantId, workspaceIds) => endCompanyAccountShares(db, tenantId, workspaceIds),
  };
}

describe('the whole company erasure with an account shared between two companies', () => {
  it('erasing the holder: no false conflict, its account and payments go, the share ends, the receiver keeps its receipts', async () => {
    const w = await sharedWorld();
    expect(await db.taxPaymentLink.count({ where: { authWorkspaceId: w.rctx.workspaceId } })).toBe(1);

    const counts = await eraseCompany(db, w.hctx.tenantId, [w.hctx.workspaceId], deps());

    expect(counts).toMatchObject({ accountShares: 1, crossCompanyLinks: 1 });
    expect(counts.register).toMatchObject({ tables: 1, receipts: 1 });
    expect(await db.taxAccount.count({ where: { id: w.accountId } })).toBe(0);
    expect(await db.taxPayment.count({ where: { authWorkspaceId: w.hctx.workspaceId } })).toBe(0);
    expect(await db.taxAccountShare.count({ where: { accountId: w.accountId } })).toBe(0);
    expect(await db.dtTable.count({ where: { id: w.holder.tableId } })).toBe(0);
    // The receiver: its table and its receipt are there, the link to the holder's payment is not.
    expect(await db.dtTable.count({ where: { id: w.receiver.tableId } })).toBe(1);
    expect((await w.receiver.adapter.getRow(w.receiverRow))?.id).toBe(w.receiverRow);
    expect(await db.taxPaymentLink.count({ where: { authWorkspaceId: w.rctx.workspaceId } })).toBe(0);
  });

  it('erasing the receiver: no false conflict, its receipts go, the share ends, the holder keeps its account, payments and receipts', async () => {
    const w = await sharedWorld();

    const counts = await eraseCompany(db, w.rctx.tenantId, [w.rctx.workspaceId], deps());

    expect(counts).toMatchObject({ accountShares: 1, crossCompanyLinks: 1 });
    expect(counts.register).toMatchObject({ tables: 1, receipts: 1 });
    expect(await db.dtTable.count({ where: { id: w.receiver.tableId } })).toBe(0);
    expect(await db.taxAccountShare.count({ where: { accountId: w.accountId } })).toBe(0);
    expect(await db.taxPaymentLink.count({ where: { authWorkspaceId: w.rctx.workspaceId } })).toBe(0);
    // The holder: everything of its own is untouched.
    expect(await db.taxAccount.count({ where: { id: w.accountId } })).toBe(1);
    expect((await loadPayments(db, w.hctx.workspaceId)).payments).toHaveLength(2);
    expect(await db.dtTable.count({ where: { id: w.holder.tableId } })).toBe(1);
    expect((await w.holder.adapter.getRow(w.holderRow))?.id).toBe(w.holderRow);
  });
});
