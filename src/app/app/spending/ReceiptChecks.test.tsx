// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const checkNow = vi.fn();
const confirmReceipt = vi.fn();
const sayNoReceipt = vi.fn();
const takeBackNoReceipt = vi.fn();
const readNotification = vi.fn();
const saveNotificationSettings = vi.fn();
const dismissMail = vi.fn();
const linkTakenOver = vi.fn();
const getReceiptChecks = vi.fn();
const takeOverMail = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock('./loop-actions', () => ({
  checkNow: (...a: unknown[]) => checkNow(...a),
  confirmReceipt: (...a: unknown[]) => confirmReceipt(...a),
  sayNoReceipt: (...a: unknown[]) => sayNoReceipt(...a),
  takeBackNoReceipt: (...a: unknown[]) => takeBackNoReceipt(...a),
  readNotification: (...a: unknown[]) => readNotification(...a),
  saveNotificationSettings: (...a: unknown[]) => saveNotificationSettings(...a),
  dismissMail: (...a: unknown[]) => dismissMail(...a),
  linkTakenOver: (...a: unknown[]) => linkTakenOver(...a),
  getReceiptChecks: (...a: unknown[]) => getReceiptChecks(...a),
}));
vi.mock('../actions', () => ({ processReceipt: vi.fn() }));
const switchWorkspace = vi.fn();
vi.mock('../workspace-actions', () => ({ switchWorkspace: (...a: unknown[]) => switchWorkspace(...a) }));
vi.mock('@/lib/upload/browser-deps', () => ({ createBrowserDeps: () => ({}) }));
vi.mock('./take-over-mail', async (orig) => ({ ...(await orig<typeof import('./take-over-mail')>()), takeOverMail: (...a: unknown[]) => takeOverMail(...a) }));

import ReceiptChecks, { checksActionMessage, runSummary } from './ReceiptChecks';
import type { ChecksView } from './loop-actions';

afterEach(cleanup);

const view = (canWrite = true): ChecksView => ({
  loop: {
    open: [
      { paymentId: 'p1', bookingDay: '2026-05-10', cents: 2999, counterparty: 'Zyx Handel', reference: '', state: { state: 'proposed', candidates: [{ rowId: 'r1', label: 'Zyx Rechnung', day: '2026-05-09', amountCents: 2999, estimated: false }] } },
      { paymentId: 'p2', bookingDay: '2026-05-12', cents: 1250, counterparty: 'Abc Laden', reference: '', state: { state: 'missing' } },
    ],
    answered: [{ paymentId: 'p3', bookingDay: '2026-05-01', cents: 300, counterparty: 'Parkhaus', reference: '', state: { state: 'no_receipt', reason: 'Automat' } }],
    counts: { hasReceipt: 4, notNeeded: { own_transfer: 1, income: 0, refund: 0, fee: 0, loan: 1, cash: 0, transfer: 0 }, noReceipt: 1, proposed: 1, in_mailbox: 0, missing: 1 },
  },
  notifications: [{ id: 'n1', subjectKey: 'missing_receipt:p2', kind: 'missing_receipt', title: 'Beleg fehlt: Abc Laden', body: '', path: '/app/spending?pruefen=p2', channel: null, failed: false, createdAt: '2026-05-12T10:00:00Z' }],
  settings: { channel: 'push', notifyEmail: null },
  canWrite,
  lastRun: null,
  workspaceId: 'ws-a',
  mailbox: 'off',
  pushPublicKey: null,
  pushDevices: 0,
});

beforeEach(() => {
  for (const f of [checkNow, confirmReceipt, sayNoReceipt, takeBackNoReceipt, readNotification, saveNotificationSettings, dismissMail, linkTakenOver, getReceiptChecks]) f.mockReset().mockResolvedValue({ ok: true, value: view() });
  Element.prototype.scrollIntoView = vi.fn();
});

describe('ReceiptChecks', () => {
  it('confirms a proposed receipt for its payment', async () => {
    render(<ReceiptChecks initial={view()} focusPaymentId={null} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Zyx Rechnung als Beleg für diese Zahlung bestätigen' }));
    expect(confirmReceipt).toHaveBeenCalledWith('p1', 'r1');
  });

  it('asks for a reason before saying there is no receipt', async () => {
    render(<ReceiptChecks initial={view()} focusPaymentId={null} />);
    const user = userEvent.setup();
    await user.click(screen.getAllByRole('button', { name: 'Es gibt keinen Beleg' })[1]);
    const save = screen.getByRole('button', { name: 'Antwort ohne Beleg für Abc Laden speichern' });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    await user.type(screen.getByLabelText('Warum es keinen Beleg gibt'), 'Parkautomat');
    await user.click(save);
    expect(sayNoReceipt).toHaveBeenCalledWith('p2', 'Parkautomat');
  });

  it('an answer given in the company holding the account is shown without a take-back button', async () => {
    const base = view();
    const inherited = { ...base, loop: { ...base.loop, answered: [{ ...base.loop.answered[0], state: { state: 'no_receipt' as const, reason: 'Automat', fromHolder: true } }] } };
    render(<ReceiptChecks initial={inherited} focusPaymentId={null} />);
    await userEvent.setup().click(screen.getByText(/Ohne Beleg beantwortet/));
    expect(screen.getByText(/beantwortet in der Firma, die das Konto führt/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Antwort für Parkhaus zurücknehmen' })).toBeNull();
    expect(checksActionMessage({ ok: false, error: 'invalid_input', detail: 'answered_by_holder' })).toMatch(/nur dort zurücknehmen/);
  });

  it('takes a "no receipt" answer back, marks a notification read, and runs a check', async () => {
    render(<ReceiptChecks initial={view()} focusPaymentId={null} />);
    const user = userEvent.setup();
    await user.click(screen.getByText(/Ohne Beleg beantwortet/));
    await user.click(screen.getByRole('button', { name: 'Antwort für Parkhaus zurücknehmen' }));
    expect(takeBackNoReceipt).toHaveBeenCalledWith('p3');
    await user.click(screen.getByRole('button', { name: 'Beleg fehlt: Abc Laden als gelesen markieren' }));
    expect(readNotification).toHaveBeenCalledWith('n1');
    await user.click(screen.getByRole('button', { name: 'Jetzt prüfen' }));
    expect(checkNow).toHaveBeenCalled();
  });

  it('shows a failure at the payment it belongs to', async () => {
    confirmReceipt.mockResolvedValue({ ok: false, error: 'invalid_input', detail: 'not_a_candidate' });
    render(<ReceiptChecks initial={view()} focusPaymentId={null} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Zyx Rechnung als Beleg für diese Zahlung bestätigen' }));
    const alert = await screen.findByRole('alert');
    expect(alert.closest('li')?.id).toBe('pruefen-p1');
  });

  it('brings the payment a notification points at into view and gives it the focus', () => {
    render(<ReceiptChecks initial={view()} focusPaymentId="p2" />);
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
    expect(document.activeElement?.id).toBe('pruefen-p2');
    expect(document.activeElement?.getAttribute('aria-current')).toBe('true');
  });

  it('says when the payment of a notification is settled by now', () => {
    render(<ReceiptChecks initial={view()} focusPaymentId="p-gone" />);
    expect(screen.getByText(/inzwischen erledigt/)).toBeTruthy();
  });

  it('focuses the reason field, and gives the focus back on cancel', async () => {
    render(<ReceiptChecks initial={view()} focusPaymentId={null} />);
    const user = userEvent.setup();
    const opener = screen.getAllByRole('button', { name: 'Es gibt keinen Beleg' })[1];
    await user.click(opener);
    expect(document.activeElement).toBe(screen.getByLabelText('Warum es keinen Beleg gibt'));
    await user.click(screen.getByRole('button', { name: 'Abbrechen' }));
    expect(document.activeElement?.textContent).toBe('Es gibt keinen Beleg');
  });

  it('saves the notification setting', async () => {
    render(<ReceiptChecks initial={view()} focusPaymentId={null} />);
    const user = userEvent.setup();
    await user.click(screen.getByText('Wie benachrichtigt wird'));
    await user.click(screen.getByLabelText('Nur E-Mail'));
    await user.type(screen.getByLabelText('E-Mail-Adresse für Benachrichtigungen'), 'owner@example.com');
    await user.click(screen.getByRole('button', { name: 'Einstellung speichern' }));
    expect(saveNotificationSettings).toHaveBeenCalledWith({ channel: 'email', notifyEmail: 'owner@example.com' });
  });

  it('offers no controls without the write permission', () => {
    render(<ReceiptChecks initial={view(false)} focusPaymentId={null} />);
    expect(screen.queryByRole('button', { name: 'Jetzt prüfen' })).toBeNull();
    expect(screen.queryByRole('button', { name: /bestätigen/ })).toBeNull();
    expect(screen.queryByText('Wie benachrichtigt wird')).toBeNull();
  });
});

describe('a notification for another company', () => {
  it('offers to switch, and switches', async () => {
    switchWorkspace.mockReset().mockResolvedValue({ ok: true });
    render(<ReceiptChecks initial={view()} focusPaymentId="p1" forCompany="ws-b" />);
    expect(screen.getByText(/gehört zu einer anderen Firma/)).toBeTruthy();
    expect(screen.queryByText(/inzwischen erledigt/)).toBeNull();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Zu dieser Firma wechseln' }));
    expect(switchWorkspace).toHaveBeenCalledWith('ws-b');
  });

  it('says so when the switch does not work', async () => {
    switchWorkspace.mockReset().mockResolvedValue({ ok: false });
    render(<ReceiptChecks initial={view()} focusPaymentId={null} forCompany="ws-b" />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Zu dieser Firma wechseln' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/Der Wechsel hat nicht geklappt/);
  });

  it('says nothing when the link is about the active company', () => {
    render(<ReceiptChecks initial={view()} focusPaymentId={null} forCompany="ws-a" />);
    expect(screen.queryByText(/anderen Firma/)).toBeNull();
  });
});

describe('a mail found in the mailbox', () => {
  const withMail = (canWrite = true): ChecksView => ({
    ...view(canWrite),
    loop: {
      ...view(canWrite).loop,
      open: [{ paymentId: 'p5', bookingDay: '2026-05-10', cents: 2999, counterparty: 'Zyx Handel', reference: '', state: { state: 'in_mailbox', mails: [{ id: 'mc1', fileName: 'Rechnung.pdf', receivedDay: '2026-05-09', subject: 'Ihre Rechnung', sender: 'billing@zyx.example' }] } }],
    },
  });

  it('takes the attachment over, links it to the payment, and says so after the row is gone', async () => {
    takeOverMail.mockResolvedValue({ kind: 'done', rowId: 'r9' });
    linkTakenOver.mockResolvedValue({ ok: true, value: view() });
    render(<ReceiptChecks initial={withMail()} focusPaymentId={null} />);
    expect(screen.getByText(/Im Postfach: Rechnung.pdf/)).toBeTruthy();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Rechnung.pdf als Beleg übernehmen' }));
    expect(takeOverMail.mock.calls[0][0]).toBe('mc1');
    expect(linkTakenOver).toHaveBeenCalledWith('p5', 'r9');
    expect(await screen.findByText('Als Beleg übernommen und mit der Zahlung verknüpft.')).toBeTruthy();
    expect(screen.queryByText(/Im Postfach: Rechnung.pdf/)).toBeNull();
    expect(document.activeElement?.tagName).toBe('H2');
  });

  it('says nothing about the mailbox in a company it does not belong to', () => {
    render(<ReceiptChecks initial={{ ...withMail(), mailbox: 'other_company' }} focusPaymentId={null} />);
    expect(screen.queryByText(/Ausgaben-Postfach/)).toBeNull();
  });

  it('says so in the row when the mailbox cannot give the attachment', async () => {
    takeOverMail.mockResolvedValue({ kind: 'failed', reason: 'mailbox_auth' });
    render(<ReceiptChecks initial={withMail()} focusPaymentId={null} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Rechnung.pdf als Beleg übernehmen' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/Zugang zum Ausgaben-Postfach ist abgelaufen/);
    expect(alert.closest('li')?.id).toBe('pruefen-p5');
    expect(linkTakenOver).not.toHaveBeenCalled();
  });

  it('sets a wrong mail aside', async () => {
    dismissMail.mockResolvedValue({ ok: true, value: view() });
    render(<ReceiptChecks initial={withMail()} focusPaymentId={null} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Rechnung.pdf ist nicht die Rechnung' }));
    expect(dismissMail).toHaveBeenCalledWith('mc1');
  });

  it('offers neither button without the write permission', () => {
    render(<ReceiptChecks initial={withMail(false)} focusPaymentId={null} />);
    expect(screen.queryByRole('button', { name: /übernehmen/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /nicht die Rechnung/ })).toBeNull();
  });
});

describe('runSummary', () => {
  it('says what a run did, in singular and plural', () => {
    expect(runSummary({ loop: { notified: 1, deferred: 0, open: 1, settled: 0, retried: 0, mailbox: { status: 'off' as const, missing: [] } }, budgets: { sent: 0, deferred: 0, settled: 0 } })).toBe(
      'Geprüft: 1 neue Benachrichtigung, 1 Zahlung wartet auf einen Beleg.',
    );
    expect(runSummary({ loop: { notified: 10, deferred: 2, open: 14, settled: 0, retried: 0, mailbox: { status: 'ok' as const, searched: 3, found: 1 } }, budgets: { sent: 2, deferred: 1, settled: 0 } })).toBe(
      'Geprüft: 10 neue Benachrichtigungen, 14 Zahlungen warten auf einen Beleg, 2 weitere folgen beim nächsten Prüfen. Im Postfach 1 Rechnung gefunden. 2 neue Budgetwarnungen, 1 weitere folgt beim nächsten Prüfen.',
    );
  });
  it('says which part could not be checked', () => {
    expect(runSummary({ loop: null, budgets: { sent: 1, deferred: 0, settled: 0 } })).toBe('Die Belege konnten nicht geprüft werden; bitte gleich noch einmal versuchen. 1 neue Budgetwarnung.');
    const failed = runSummary({ loop: { notified: 0, deferred: 0, open: 0, settled: 0, retried: 0, mailbox: { status: 'error' as const, code: 'auth_failed' as const, searched: 1, found: 0 } }, budgets: null });
    expect(failed).toMatch(/Die Budgets konnten nicht geprüft werden/);
    expect(failed).toMatch(/Zugang zum Ausgaben-Postfach ist abgelaufen/);
  });
});

describe('checksActionMessage', () => {
  it('says what to do', () => {
    expect(checksActionMessage({ ok: false, error: 'invalid_input', detail: 'reason_required' })).toMatch(/warum/);
    expect(checksActionMessage({ ok: false, error: 'invalid_input', detail: 'receipt_already_paid:100:90' })).toMatch(/schon durch andere Zahlungen/);
    expect(checksActionMessage({ ok: false, error: 'not_found' })).toMatch(/gibt es nicht mehr/);
    expect(checksActionMessage({ ok: false, error: 'invalid_input', detail: 'invalid_email' })).toMatch(/E-Mail/);
  });
});
