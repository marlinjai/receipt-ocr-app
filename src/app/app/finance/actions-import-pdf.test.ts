import { beforeEach, describe, expect, it, vi } from 'vitest';
import { statementPdf } from '@/lib/tax/payments/__tests__/advanzia-fixture';

/**
 * The import of a statement PDF through the finance action: the file arrives
 * as form data, its text is taken on the server and read as a PDF only. The
 * session and the payments service are stand-ins; the PDF is generated, every
 * amount invented.
 */

const s = vi.hoisted(() => ({ importPayments: vi.fn(), loadStatement: vi.fn() }));

vi.mock('next/server', () => ({ after: async (fn: () => unknown) => fn() }));
vi.mock('@/lib/auth', () => ({ auth: { requireAction: vi.fn(async () => ({ memberships: [] })) } }));
vi.mock('@/lib/auth-workspace', async (original) => ({
  ...(await original<typeof import('@/lib/auth-workspace')>()),
  sessionWorkspaceId: () => 'ws-1',
  requireSessionTenantId: () => 'tenant-1',
}));
vi.mock('@/lib/prisma', () => ({ prisma: { marker: 'prisma' } }));
vi.mock('@/lib/tax/service', async (original) => ({ ...(await original<typeof import('@/lib/tax/service')>()), loadStatement: s.loadStatement }));
vi.mock('@/lib/tax/payments/service', async (original) => ({ ...(await original<typeof import('@/lib/tax/payments/service')>()), importPayments: s.importPayments }));
vi.mock('@/lib/spending/checks', () => ({ runSpendingChecksAfterNewPayments: vi.fn() }));

import { importPaymentPdf } from './actions';

const form = (file: Blob | string | null) => {
  const f = new FormData();
  if (file !== null) f.append('file', file);
  return f;
};

beforeEach(() => {
  s.importPayments.mockReset();
  s.loadStatement.mockResolvedValue({ year: 2026 });
  s.importPayments.mockResolvedValue({ added: 1 });
});

describe('importing a statement PDF', () => {
  it('hands the text of the PDF to the import, to be read as a PDF only', async () => {
    const pdf = await statementPdf({ from: '04.03.2026', to: '03.04.2026', oldBalance: '0,00', rows: [{ day: '05.03.2026', text: 'Laden Beispiel', place: 'Berlin', amount: '19,11' }] });
    const result = await importPaymentPdf(2026, 'acc-1', form(new Blob([pdf.slice().buffer], { type: 'application/pdf' })), true);
    expect(result).toEqual({ ok: true, value: { view: { year: 2026 }, imported: { added: 1 } } });
    const [, ctx, accountId, text, options] = s.importPayments.mock.calls[0];
    expect([ctx, accountId]).toEqual([{ workspaceId: 'ws-1', tenantId: 'tenant-1' }, 'acc-1']);
    expect(text).toMatch(/05\.03\.2026 {2,}Laden Beispiel {2,}Berlin {2,}19,11/);
    expect(options).toEqual({ onlyYear: 2026, parse: { pdf: true } });
  });

  it('refuses form data without a file, and bytes that are no PDF, with a message and without importing', async () => {
    expect(await importPaymentPdf(2026, 'acc-1', form(null))).toEqual({ ok: false, error: 'invalid_input', detail: 'unreadable_pdf' });
    expect(await importPaymentPdf(2026, 'acc-1', form('Booking Date,Amount'))).toEqual({ ok: false, error: 'invalid_input', detail: 'unreadable_pdf' });
    expect(await importPaymentPdf(2026, 'acc-1', form(new Blob(['Booking Date,Amount\n'])))).toEqual({ ok: false, error: 'invalid_input', detail: 'unreadable_pdf' });
    expect(s.importPayments).not.toHaveBeenCalled();
  });
});
