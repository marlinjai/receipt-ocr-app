// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { CheckChange, ChecksView } from './loop-actions';

const drawn = vi.hoisted(() => ({ days: [] as string[] }));
vi.mock('@/lib/meals/messages', async (original) => {
  const real = await original<typeof import('@/lib/meals/messages')>();
  return {
    ...real,
    formatDay: (day: string) => {
      drawn.days.push(day);
      return real.formatDay(day);
    },
  };
});
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
const change = (paymentId: string, state: CheckChange['state'], rowId: string | null = null): CheckChange => ({ paymentId, state, rowId, settled: [], at: 2 });
vi.mock('./loop-actions', () => ({
  sayNoReceipt: async (paymentId: string, reason: string) => ({ ok: true, value: change(paymentId, { state: 'no_receipt', reason }) }),
  confirmReceipt: async (paymentId: string, rowId: string) => ({ ok: true, value: change(paymentId, { state: 'has_receipt' }, rowId) }),
}));
vi.mock('../actions', () => ({ processReceipt: vi.fn() }));
vi.mock('../workspace-actions', () => ({ switchWorkspace: vi.fn() }));
vi.mock('@/lib/upload/browser-deps', () => ({ createBrowserDeps: () => ({}) }));
vi.mock('./take-over-mail', () => ({ takeOverMail: vi.fn(), takeOverMessage: vi.fn() }));

import ReceiptChecks from './ReceiptChecks';

afterEach(cleanup);

const candidate = (rowId: string, label: string) => ({ rowId, label, day: '2026-01-01', amountCents: 1000, estimated: false });

const view: ChecksView = {
  readAt: 1,
  backlogBefore: '2026-01-01',
  loop: {
    open: [
      { paymentId: 'a', bookingDay: '2026-05-10', cents: 1000, counterparty: 'Erster', reference: '', state: { state: 'proposed', candidates: [candidate('r1', 'Beleg Eins'), candidate('r2', 'Beleg Zwei')] } },
      { paymentId: 'b', bookingDay: '2026-05-09', cents: 1000, counterparty: 'Zweiter', reference: '', state: { state: 'proposed', candidates: [candidate('r1', 'Beleg Eins')] } },
      { paymentId: 'c', bookingDay: '2026-05-08', cents: 500, counterparty: 'Dritter', reference: '', state: { state: 'missing' } },
    ],
    answered: [],
    counts: { hasReceipt: 0, notNeeded: { old: 0, own_transfer: 0, income: 0, refund: 0, fee: 0, loan: 0, cash: 0, transfer: 0 }, noReceipt: 0, proposed: 2, in_mailbox: 0, missing: 1 },
  },
  notifications: [],
  settings: { channel: 'push', notifyEmail: null },
  canWrite: true,
  lastRun: null,
  workspaceId: 'ws-a',
  mailbox: 'off',
  pushPublicKey: null,
  pushDevices: 0,
};

describe('an answer about one payment', () => {
  it('leaves the rows it does not touch alone, also the ones around a payment that left', async () => {
    render(<ReceiptChecks initial={view} focusPaymentId={null} />);
    const user = userEvent.setup();
    await user.click(screen.getAllByRole('button', { name: 'Es gibt keinen Beleg' })[2]);
    await user.type(screen.getByLabelText('Warum es keinen Beleg gibt'), 'Automat');
    drawn.days.length = 0;
    await user.click(screen.getByRole('button', { name: 'Antwort ohne Beleg für Dritter speichern' }));
    await waitFor(() => expect(screen.getByText('Belege prüfen (2 offen)')).toBeTruthy());
    expect(drawn.days).not.toContain('2026-05-10');
    expect(drawn.days).not.toContain('2026-05-09');
  });

  it('redraws a row that lost a proposal to the link, and the row it does not concern stays', async () => {
    render(<ReceiptChecks initial={view} focusPaymentId={null} />);
    drawn.days.length = 0;
    await userEvent.setup().click(screen.getAllByRole('button', { name: 'Beleg Eins als Beleg für diese Zahlung bestätigen' })[1]);
    await waitFor(() => expect(screen.getByText('Belege prüfen (2 offen)')).toBeTruthy());
    expect(drawn.days).toContain('2026-05-10');
    expect(drawn.days).not.toContain('2026-05-08');
  });
});
