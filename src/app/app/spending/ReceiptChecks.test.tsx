// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
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
const linkChosenReceipt = vi.fn();
const linkCertain = vi.fn();
const closeReceiptBacklog = vi.fn();
const findReceiptChoices = vi.fn();
const takeOverMail = vi.fn();
const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh, push: vi.fn() }) }));
vi.mock('./loop-actions', () => ({
  checkNow: (...a: unknown[]) => checkNow(...a),
  confirmReceipt: (...a: unknown[]) => confirmReceipt(...a),
  sayNoReceipt: (...a: unknown[]) => sayNoReceipt(...a),
  takeBackNoReceipt: (...a: unknown[]) => takeBackNoReceipt(...a),
  readNotification: (...a: unknown[]) => readNotification(...a),
  saveNotificationSettings: (...a: unknown[]) => saveNotificationSettings(...a),
  dismissMail: (...a: unknown[]) => dismissMail(...a),
  linkTakenOver: (...a: unknown[]) => linkTakenOver(...a),
  linkChosenReceipt: (...a: unknown[]) => linkChosenReceipt(...a),
  linkCertain: (...a: unknown[]) => linkCertain(...a),
  closeReceiptBacklog: (...a: unknown[]) => closeReceiptBacklog(...a),
  findReceiptChoices: (...a: unknown[]) => findReceiptChoices(...a),
  getReceiptChecks: (...a: unknown[]) => getReceiptChecks(...a),
}));
vi.mock('../actions', () => ({ processReceipt: vi.fn() }));
const switchWorkspace = vi.fn();
vi.mock('../workspace-actions', () => ({ switchWorkspace: (...a: unknown[]) => switchWorkspace(...a) }));
vi.mock('@/lib/upload/browser-deps', () => ({ createBrowserDeps: () => ({}) }));
vi.mock('./take-over-mail', async (orig) => ({ ...(await orig<typeof import('./take-over-mail')>()), takeOverMail: (...a: unknown[]) => takeOverMail(...a) }));

import Refusals from '@/components/Refusals';
import { AppStore } from '@/stores/AppStore';
import { AppStoreContext } from '@/stores/provider';
import ReceiptChecks, { checksActionMessage, runSummary } from './ReceiptChecks';
import type { CheckChange, ChecksView } from './loop-actions';

afterEach(cleanup);

const view = (canWrite = true): ChecksView => ({
  readAt: 1,
  backlogBefore: '2026-05-01',
  loop: {
    open: [
      { paymentId: 'p1', bookingDay: '2026-05-10', cents: 2999, counterparty: 'Zyx Handel', reference: '', state: { state: 'proposed', candidates: [{ rowId: 'r1', label: 'Zyx Rechnung', day: '2026-05-09', amountCents: 2999, estimated: false }] } },
      { paymentId: 'p2', bookingDay: '2026-05-09', cents: 1250, counterparty: 'Abc Laden', reference: '', state: { state: 'missing' } },
    ],
    answered: [{ paymentId: 'p3', bookingDay: '2026-05-01', cents: 300, counterparty: 'Parkhaus', reference: '', state: { state: 'no_receipt', reason: 'Automat' } }],
    counts: { hasReceipt: 4, notNeeded: { old: 0, own_transfer: 1, income: 0, refund: 0, fee: 0, loan: 1, cash: 0, transfer: 0 }, noReceipt: 1, proposed: 1, in_mailbox: 0, missing: 1 },
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

const change = (paymentId: string, state: CheckChange['state'], rowId: string | null = null, settled: string[] = []): CheckChange => ({ paymentId, state, rowId, settled, at: 2 });

beforeEach(() => {
  refresh.mockReset();
  takeOverMail.mockClear();
  for (const f of [checkNow, saveNotificationSettings, linkCertain, closeReceiptBacklog, getReceiptChecks]) f.mockReset().mockResolvedValue({ ok: true, value: view() });
  const linked = async (paymentId: string, rowId: string) => ({ ok: true, value: change(paymentId, { state: 'has_receipt' }, rowId) });
  for (const f of [confirmReceipt, linkTakenOver, linkChosenReceipt]) f.mockReset().mockImplementation(linked);
  sayNoReceipt.mockReset().mockImplementation(async (paymentId: string, reason: string) => ({ ok: true, value: change(paymentId, { state: 'no_receipt', reason }) }));
  takeBackNoReceipt.mockReset().mockImplementation(async (paymentId: string) => ({ ok: true, value: change(paymentId, { state: 'missing' }) }));
  dismissMail.mockReset().mockResolvedValue({ ok: true, value: change('p5', { state: 'missing' }) });
  readNotification.mockReset().mockResolvedValue({ ok: true, value: { at: 2 } });
  findReceiptChoices.mockReset();
  Element.prototype.scrollIntoView = vi.fn();
});

describe('ReceiptChecks', () => {
  it('confirms a proposed receipt for its payment', async () => {
    render(<ReceiptChecks initial={view()} focusPaymentId={null} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Zyx Rechnung als Beleg für diese Zahlung bestätigen' }));
    expect(confirmReceipt).toHaveBeenCalledWith('p1', 'r1');
  });

  it("each card's upload button opens the upload page for that payment, so the receipt is linked to it", () => {
    render(<ReceiptChecks initial={view()} focusPaymentId={null} />);
    const links = screen.getAllByRole('link', { name: 'Beleg fotografieren oder hochladen' }).map((l) => l.getAttribute('href'));
    expect(links).toEqual(['/app?fuer=p1', '/app?fuer=p2']);
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

  it('links a receipt chosen by hand when no proposal fits, only after one is chosen, and says so at the page', async () => {
    findReceiptChoices.mockResolvedValue({ ok: true, value: [{ rowId: 'r9', label: 'Kassenbon', vendor: 'Abc Laden', day: '2026-05-11', amountCents: 1250, estimated: false, openCents: 1250 }] });
    const { unmount } = render(<ReceiptChecks initial={view()} focusPaymentId={null} />);
    const user = userEvent.setup();
    // Asked from the server only on request, for the payment a person works on; the focus goes to the search.
    expect(findReceiptChoices).not.toHaveBeenCalled();
    await user.click(screen.getAllByRole('button', { name: 'Vorhandenen Beleg zuordnen' })[1]);
    expect(findReceiptChoices).toHaveBeenCalledWith('p2', '');
    expect(document.activeElement).toBe(screen.getByLabelText('Belege durchsuchen (Name, Lieferant oder Betrag)'));
    expect(await screen.findByText('1 Beleg zur Auswahl.')).toBeTruthy();
    const link = screen.getByRole('button', { name: 'Zuordnen: gewählten Beleg zu Abc Laden' });
    expect((link as HTMLButtonElement).disabled).toBe(true);
    await user.selectOptions(screen.getByLabelText('Vorhandenen Beleg für Abc Laden wählen'), 'r9');
    await user.click(link);
    expect(linkChosenReceipt).toHaveBeenCalledWith('p2', 'r9');
    expect(await screen.findByText('Beleg zugeordnet: Abc Laden.')).toBeTruthy();
    // The overview and the budgets are other tabs: no read while the list is worked on, one on leaving.
    expect(refresh).not.toHaveBeenCalled();
    unmount();
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('links the certain receipts only after asking, and says how many went', async () => {
    const base = view();
    linkCertain.mockResolvedValue({ ok: true, value: { ...base, loop: { ...base.loop, open: base.loop.open.slice(1) } } });
    render(<ReceiptChecks initial={base} focusPaymentId={null} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: '1 sichere Belege zuordnen' }));
    expect(linkCertain).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Zuordnen' }));
    expect(linkCertain).toHaveBeenCalledOnce();
    expect(await screen.findByText('1 Beleg zugeordnet.')).toBeTruthy();
  });

  it('closes the backlog only after asking, and says what went where', async () => {
    const base = { ...view(), backlogBefore: '2026-06-01' };
    closeReceiptBacklog.mockResolvedValue({ ok: true, value: { ...base, closed: { linked: 1, privately: 2, notFound: 3 } } });
    render(<ReceiptChecks initial={base} focusPaymentId={null} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /abschließen \(2\)/ }));
    expect(closeReceiptBacklog).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Abschließen' }));
    expect(closeReceiptBacklog).toHaveBeenCalledOnce();
    expect(await screen.findByText('Abgeschlossen: 1 zugeordnet, 2 privat ohne Beleg, 3 nicht auffindbar.')).toBeTruthy();
  });

  it('offers no closing while nothing older than the running month is open', () => {
    render(<ReceiptChecks initial={view()} focusPaymentId={null} />);
    expect(screen.queryByRole('button', { name: /abschließen/ })).toBeNull();
  });

  it('shows what could not be found apart, with the way back', () => {
    const base = view();
    const lost = { paymentId: 'p9', bookingDay: '2026-03-01', cents: 5000, counterparty: 'Xyz Beratung', reference: '', state: { state: 'no_receipt' as const, reason: 'Nicht auffindbar' } };
    render(<ReceiptChecks initial={{ ...base, loop: { ...base.loop, answered: [...base.loop.answered, lost] } }} focusPaymentId={null} />);
    expect(screen.getByText('Nicht auffindbar (1)')).toBeTruthy();
    expect(screen.getByText('Ohne Beleg beantwortet (1)')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Antwort für Xyz Beratung zurücknehmen' })).toBeTruthy();
  });

  it('offers no certain link while none exists, nor to someone who may only read', () => {
    render(<ReceiptChecks initial={view(false)} focusPaymentId={null} />);
    expect(screen.queryByRole('button', { name: /sichere Belege/ })).toBeNull();
    cleanup();
    const base = view();
    render(<ReceiptChecks initial={{ ...base, loop: { ...base.loop, open: base.loop.open.slice(1) } }} focusPaymentId={null} />);
    expect(screen.queryByRole('button', { name: /sichere Belege/ })).toBeNull();
  });

  it('keeps the summary of "Jetzt prüfen" when the page reads the checks afresh', async () => {
    const base = view();
    checkNow.mockResolvedValue({ ok: true, value: { ...base, lastRun: { classify: { pending: 0, byEvidence: 0, byModel: 0, applied: 0, unavailable: false, failedBatches: 0, unanswered: 0, removed: 0, stoppedEarly: false }, loop: { notified: 1, settled: 0, settledOwnName: 0, retried: 0, open: 2, deferred: 0, mailbox: { status: 'off', missing: [] } }, budgets: null } } });
    const { rerender } = render(<ReceiptChecks initial={base} focusPaymentId={null} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Jetzt prüfen' }));
    const summary = (await screen.findByText(/Geprüft/)).textContent;
    rerender(<ReceiptChecks initial={{ ...base }} focusPaymentId={null} />);
    expect(screen.getByText(/Geprüft/).textContent).toBe(summary);
  });

  it('keeps what was typed and chosen in an open list when the page reads afresh, and asks once more', async () => {
    findReceiptChoices.mockResolvedValue({ ok: true, value: [{ rowId: 'r9', label: 'Kassenbon', vendor: null, day: null, amountCents: 1250, estimated: false, openCents: 1250 }] });
    const base = view();
    const { rerender } = render(<ReceiptChecks initial={base} focusPaymentId={null} />);
    const user = userEvent.setup();
    await user.click(screen.getAllByRole('button', { name: 'Vorhandenen Beleg zuordnen' })[1]);
    await user.selectOptions(await screen.findByLabelText('Vorhandenen Beleg für Abc Laden wählen'), 'r9');
    await user.type(screen.getByLabelText('Belege durchsuchen (Name, Lieferant oder Betrag)'), 'Kas');
    rerender(<ReceiptChecks initial={{ ...base }} focusPaymentId={null} />);
    await waitFor(() => expect(findReceiptChoices).toHaveBeenCalledTimes(2));
    expect((screen.getByLabelText('Vorhandenen Beleg für Abc Laden wählen') as HTMLSelectElement).value).toBe('r9');
    expect((screen.getByLabelText('Belege durchsuchen (Name, Lieferant oder Betrag)') as HTMLInputElement).value).toBe('Kas');
  });

  it('keeps an error about a payment still open when the page reads afresh', async () => {
    findReceiptChoices.mockResolvedValue({ ok: true, value: [{ rowId: 'r9', label: 'Kassenbon', vendor: null, day: null, amountCents: 1250, estimated: false, openCents: 1250 }] });
    linkChosenReceipt.mockResolvedValue({ ok: false, error: 'invalid_input', detail: 'already_has_receipt' });
    const base = view();
    const { rerender } = render(<ReceiptChecks initial={base} focusPaymentId={null} />);
    const user = userEvent.setup();
    await user.click(screen.getAllByRole('button', { name: 'Vorhandenen Beleg zuordnen' })[1]);
    await user.selectOptions(await screen.findByLabelText('Vorhandenen Beleg für Abc Laden wählen'), 'r9');
    await user.click(screen.getByRole('button', { name: 'Zuordnen: gewählten Beleg zu Abc Laden' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/inzwischen schon ein Beleg/);
    rerender(<ReceiptChecks initial={{ ...base }} focusPaymentId={null} />);
    expect(screen.getByRole('alert').textContent).toMatch(/inzwischen schon ein Beleg/);
  });

  it('asks an open list again quietly after a fresh read: no searching message, the status stays', async () => {
    let answerSecond: (v: unknown) => void = () => {};
    findReceiptChoices
      .mockResolvedValueOnce({ ok: true, value: [{ rowId: 'r9', label: 'Kassenbon', vendor: null, day: null, amountCents: 1250, estimated: false, openCents: 1250 }] })
      .mockImplementationOnce(() => new Promise((resolve) => (answerSecond = resolve)));
    const base = view();
    const { rerender } = render(<ReceiptChecks initial={base} focusPaymentId={null} />);
    await userEvent.setup().click(screen.getAllByRole('button', { name: 'Vorhandenen Beleg zuordnen' })[1]);
    expect(await screen.findByText('1 Beleg zur Auswahl.')).toBeTruthy();
    rerender(<ReceiptChecks initial={{ ...base }} focusPaymentId={null} />);
    await waitFor(() => expect(findReceiptChoices).toHaveBeenCalledTimes(2));
    expect(screen.queryByText('Belege werden gesucht …')).toBeNull();
    expect(screen.getByText('1 Beleg zur Auswahl.')).toBeTruthy();
    answerSecond({ ok: true, value: [] });
  });

  it('marking a notification read reads nothing else afresh', async () => {
    render(<ReceiptChecks initial={view()} focusPaymentId={null} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Beleg fehlt: Abc Laden als gelesen markieren' }));
    await waitFor(() => expect(readNotification).toHaveBeenCalled());
    expect(refresh).not.toHaveBeenCalled();
  });

  it('takes over fresh data the page read after a change elsewhere on it', () => {
    const base = view();
    const { rerender } = render(<ReceiptChecks initial={base} focusPaymentId={null} />);
    expect(screen.getByText('Belege prüfen (2 offen)')).toBeTruthy();
    rerender(<ReceiptChecks initial={{ ...base, loop: { ...base.loop, open: base.loop.open.slice(0, 1) } }} focusPaymentId={null} />);
    expect(screen.getByText('Belege prüfen (1 offen)')).toBeTruthy();
  });

  it('closes the picker with "Abbrechen" and gives the focus back to its opener', async () => {
    findReceiptChoices.mockResolvedValue({ ok: true, value: [] });
    render(<ReceiptChecks initial={view()} focusPaymentId={null} />);
    const user = userEvent.setup();
    await user.click(screen.getAllByRole('button', { name: 'Vorhandenen Beleg zuordnen' })[1]);
    await user.click(screen.getByRole('button', { name: 'Abbrechen: Beleg zuordnen' }));
    expect(document.activeElement).toBe(screen.getAllByRole('button', { name: 'Vorhandenen Beleg zuordnen' })[1]);
    // Reopened, it asks the server afresh.
    await user.click(screen.getAllByRole('button', { name: 'Vorhandenen Beleg zuordnen' })[1]);
    expect(findReceiptChoices).toHaveBeenCalledTimes(2);
  });

  it('drops a slow answer that a newer request overtook', async () => {
    let answerFirst: (v: unknown) => void = () => {};
    findReceiptChoices
      .mockImplementationOnce(() => new Promise((resolve) => (answerFirst = resolve)))
      .mockResolvedValueOnce({ ok: true, value: [{ rowId: 'new', label: 'Neuer Beleg', vendor: null, day: null, amountCents: 1250, estimated: false, openCents: 1250 }] });
    render(<ReceiptChecks initial={view()} focusPaymentId={null} />);
    const user = userEvent.setup();
    await user.click(screen.getAllByRole('button', { name: 'Vorhandenen Beleg zuordnen' })[1]);
    await user.type(screen.getByLabelText('Belege durchsuchen (Name, Lieferant oder Betrag)'), 'Neu');
    await user.click(screen.getByRole('button', { name: 'Suchen' }));
    expect(await screen.findByRole('option', { name: 'Neuer Beleg, 12,50 €' })).toBeTruthy();
    answerFirst({ ok: true, value: [{ rowId: 'old', label: 'Alter Beleg', vendor: null, day: null, amountCents: 1250, estimated: false, openCents: 1250 }] });
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByRole('option', { name: 'Alter Beleg, 12,50 €' })).toBeNull();
  });

  it('searches the receipts for a payment and says when nothing fits', async () => {
    findReceiptChoices.mockResolvedValueOnce({ ok: true, value: [] });
    findReceiptChoices.mockResolvedValueOnce({ ok: true, value: [{ rowId: 'r7', label: 'Altbeleg', vendor: null, day: null, amountCents: 3000, estimated: true, openCents: 1250 }] });
    render(<ReceiptChecks initial={view()} focusPaymentId={null} />);
    const user = userEvent.setup();
    await user.click(screen.getAllByRole('button', { name: 'Vorhandenen Beleg zuordnen' })[1]);
    expect(await screen.findByText(/Kein offener Beleg in dieser Firma/)).toBeTruthy();
    await user.type(screen.getByLabelText('Belege durchsuchen (Name, Lieferant oder Betrag)'), 'Alt');
    await user.click(screen.getByRole('button', { name: 'Suchen' }));
    expect(findReceiptChoices).toHaveBeenCalledWith('p2', 'Alt');
    expect(await screen.findByRole('option', { name: 'Altbeleg, ca. 30,00 €, noch offen ca. 12,50 €' })).toBeTruthy();
    expect(screen.getByText('1 Beleg gefunden.')).toBeTruthy();
    findReceiptChoices.mockResolvedValueOnce({ ok: true, value: [] });
    await user.click(screen.getByRole('button', { name: 'Suchen' }));
    expect(await screen.findByText('Kein offener Beleg passt zu dieser Suche.')).toBeTruthy();
  });

  it('words the refusals of a hand choice', () => {
    expect(checksActionMessage({ ok: false, error: 'invalid_input', detail: 'already_has_receipt' })).toMatch(/inzwischen schon ein Beleg/);
    expect(checksActionMessage({ ok: false, error: 'invalid_input', detail: 'payment_not_open' })).toMatch(/wartet auf keinen Beleg mehr/);
    expect(checksActionMessage({ ok: false, error: 'invalid_input', detail: 'target_not_found' })).toMatch(/nicht mehr da/);
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
    await user.click(screen.getByRole('button', { name: 'Abbrechen: kein Beleg' }));
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

describe('an answer about one payment', () => {
  const deferred = <T,>() => {
    let resolve: (value: T) => void = () => {};
    const promise = new Promise<T>((r) => (resolve = r));
    return { promise, resolve };
  };
  const confirmButton = 'Zyx Rechnung als Beleg für diese Zahlung bestätigen';

  it('shows at once, before the server has said anything, and the heading takes the focus', async () => {
    const answer = deferred<unknown>();
    confirmReceipt.mockReturnValue(answer.promise);
    render(<ReceiptChecks initial={view()} focusPaymentId={null} />);
    await userEvent.setup().click(screen.getByRole('button', { name: confirmButton }));
    expect(screen.getByText('Belege prüfen (1 offen)')).toBeTruthy();
    expect(screen.getByText(/^5 mit Beleg/)).toBeTruthy();
    expect(document.activeElement?.tagName).toBe('H2');
    // The notice says what the server did, so it waits for the server.
    expect(screen.queryByText('Beleg zugeordnet: Zyx Handel.')).toBeNull();
    answer.resolve({ ok: true, value: change('p1', { state: 'has_receipt' }, 'r1') });
    expect(await screen.findByText('Beleg zugeordnet: Zyx Handel.')).toBeTruthy();
  });

  it('leaves the other rows usable while it is on its way', async () => {
    confirmReceipt.mockReturnValue(new Promise(() => {}));
    render(<ReceiptChecks initial={view()} focusPaymentId={null} />);
    await userEvent.setup().click(screen.getByRole('button', { name: confirmButton }));
    expect((screen.getByRole('button', { name: 'Es gibt keinen Beleg' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('a refusal brings the payment back with the error at its row, and the same answer can be given again', async () => {
    confirmReceipt.mockResolvedValueOnce({ ok: false, error: 'invalid_input', detail: 'not_a_candidate' });
    render(<ReceiptChecks initial={view()} focusPaymentId={null} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: confirmButton }));
    const alert = await screen.findByRole('alert');
    expect(alert.closest('li')?.id).toBe('pruefen-p1');
    expect(screen.getByText('Belege prüfen (2 offen)')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: confirmButton }));
    expect(await screen.findByText('Beleg zugeordnet: Zyx Handel.')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('no answer at all counts as a refusal', async () => {
    confirmReceipt.mockRejectedValueOnce(new Error('network'));
    render(<ReceiptChecks initial={view()} focusPaymentId={null} />);
    await userEvent.setup().click(screen.getByRole('button', { name: confirmButton }));
    expect((await screen.findByRole('alert')).closest('li')?.id).toBe('pruefen-p1');
  });

  it('a notification read shows at once, and comes back with the error when refused', async () => {
    readNotification.mockResolvedValueOnce({ ok: false, error: 'failed' });
    render(<ReceiptChecks initial={view()} focusPaymentId={null} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Beleg fehlt: Abc Laden als gelesen markieren' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Beleg fehlt: Abc Laden als gelesen markieren' })).toBeTruthy();
  });

  it('a message settled by the answer leaves the queue', async () => {
    sayNoReceipt.mockResolvedValueOnce({ ok: true, value: change('p2', { state: 'no_receipt', reason: 'Automat' }, null, ['missing_receipt:p2']) });
    render(<ReceiptChecks initial={view()} focusPaymentId={null} />);
    const user = userEvent.setup();
    await user.click(screen.getAllByRole('button', { name: 'Es gibt keinen Beleg' })[1]);
    await user.type(screen.getByLabelText('Warum es keinen Beleg gibt'), 'Automat');
    await user.click(screen.getByRole('button', { name: 'Antwort ohne Beleg für Abc Laden speichern' }));
    await waitFor(() => expect(screen.queryByText('Benachrichtigungen (1)')).toBeNull());
  });

  it('an answer arriving after the panel closed still reads the page', async () => {
    const answer = deferred<unknown>();
    confirmReceipt.mockReturnValue(answer.promise);
    const { unmount } = render(<ReceiptChecks initial={view()} focusPaymentId={null} />);
    await userEvent.setup().click(screen.getByRole('button', { name: confirmButton }));
    unmount();
    expect(refresh).not.toHaveBeenCalled();
    answer.resolve({ ok: true, value: change('p1', { state: 'has_receipt' }, 'r1') });
    await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
  });

  it('leaving without having changed anything reads nothing', () => {
    const { unmount } = render(<ReceiptChecks initial={view()} focusPaymentId={null} />);
    unmount();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('an older page read arriving after the answer does not bring the payment back', async () => {
    const stale = view();
    const { rerender } = render(<ReceiptChecks initial={stale} focusPaymentId={null} />);
    await userEvent.setup().click(screen.getByRole('button', { name: confirmButton }));
    expect(await screen.findByText('Beleg zugeordnet: Zyx Handel.')).toBeTruthy();
    // Started before the answer (at 2), so it still lists the payment.
    rerender(<ReceiptChecks initial={{ ...stale }} focusPaymentId={null} />);
    expect(screen.getByText('Belege prüfen (1 offen)')).toBeTruthy();
    rerender(<ReceiptChecks initial={{ ...stale, readAt: 3 }} focusPaymentId={null} />);
    expect(screen.getByText('Belege prüfen (2 offen)')).toBeTruthy();
  });
});

describe('a refusal reaches the person', () => {
  const app = () => new AppStore();
  /** The panel in the shell, with the real stores: what `layout.tsx` draws around it. */
  const shell = (store: AppStore, initial: ChecksView | null) => (
    <AppStoreContext.Provider value={store}>
      {initial && <ReceiptChecks initial={initial} focusPaymentId={null} />}
      <Refusals />
    </AppStoreContext.Provider>
  );
  const later = <T,>() => {
    let resolve: (value: T) => void = () => {};
    const promise = new Promise<T>((r) => (resolve = r));
    return { promise, resolve };
  };
  const refused = { ok: false, error: 'invalid_input', detail: 'not_a_candidate' };
  const confirmButton = 'Zyx Rechnung als Beleg für diese Zahlung bestätigen';

  it('after the panel closed: the shell says it, naming the payment, until it is closed', async () => {
    const answer = later<unknown>();
    confirmReceipt.mockReturnValue(answer.promise);
    const store = app();
    const { rerender } = render(shell(store, view()));
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: confirmButton }));
    // "Überblick": the panel is gone, the person believes it linked.
    rerender(shell(store, null));
    expect(screen.queryByRole('alert')).toBeNull();
    answer.resolve(refused);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/^Zyx Handel, 10\.05\.2026, 29,99.*passt nicht mehr/);
    await user.click(screen.getByRole('button', { name: 'Hinweis schließen' }));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('after the panel closed: a receipt made and not linked says so in the shell', async () => {
    const base = view();
    const withMail = { ...base, loop: { ...base.loop, open: [{ ...base.loop.open[1], state: { state: 'in_mailbox' as const, mails: [{ id: 'm1', fileName: 'Rechnung.pdf', receivedDay: '2026-05-12', subject: 'Rechnung', sender: 'laden@example.com' }] } }] } };
    const link = later<unknown>();
    takeOverMail.mockResolvedValue({ kind: 'done', rowId: 'r-new' });
    linkTakenOver.mockReturnValue(link.promise);
    const store = app();
    const { rerender } = render(shell(store, withMail));
    await userEvent.setup().click(screen.getByRole('button', { name: 'Rechnung.pdf als Beleg übernehmen' }));
    await waitFor(() => expect(linkTakenOver).toHaveBeenCalled());
    rerender(shell(store, null));
    link.resolve({ ok: false, error: 'not_found', detail: 'payment_not_found' });
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/^Abc Laden.*noch nicht mit der Zahlung verknüpft/);
  });

  it('a mail whose link failed keeps its message at the row while the payment is open', async () => {
    const base = view();
    const withMail = { ...base, loop: { ...base.loop, open: [{ ...base.loop.open[1], state: { state: 'in_mailbox' as const, mails: [{ id: 'm1', fileName: 'Rechnung.pdf', receivedDay: '2026-05-12', subject: 'Rechnung', sender: 'laden@example.com' }] } }] } };
    takeOverMail.mockResolvedValue({ kind: 'done', rowId: 'r-new' });
    linkTakenOver.mockResolvedValue({ ok: false, error: 'not_found', detail: 'payment_not_found' });
    getReceiptChecks.mockResolvedValue({ ok: true, value: withMail });
    render(shell(app(), withMail));
    await userEvent.setup().click(screen.getByRole('button', { name: 'Rechnung.pdf als Beleg übernehmen' }));
    const atRow = await screen.findByRole('alert');
    expect(atRow.textContent).toMatch(/noch nicht mit der Zahlung verknüpft/);
    expect(atRow.closest('li')).not.toBeNull();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('two refusals both stay, each at its row, and answering a third leaves them', async () => {
    const base = view();
    confirmReceipt.mockResolvedValue(refused);
    sayNoReceipt.mockImplementation(async (paymentId: string) => (paymentId === 'p2' ? { ok: false, error: 'not_found', detail: 'payment_not_found' } : { ok: true, value: change(paymentId, { state: 'no_receipt', reason: 'x' }) }));
    const third = { paymentId: 'p4', bookingDay: '2026-05-08', cents: 500, counterparty: 'Drei', reference: '', state: { state: 'missing' as const } };
    render(shell(app(), { ...base, loop: { ...base.loop, open: [...base.loop.open, third] } }));
    const user = userEvent.setup();
    const say = async (index: number, name: string) => {
      await user.click(screen.getAllByRole('button', { name: 'Es gibt keinen Beleg' })[index]);
      await user.type(screen.getByLabelText('Warum es keinen Beleg gibt'), 'x');
      await user.click(screen.getByRole('button', { name: `Antwort ohne Beleg für ${name} speichern` }));
    };
    await user.click(screen.getByRole('button', { name: confirmButton }));
    await screen.findByRole('alert');
    await say(1, 'Abc Laden');
    await waitFor(() => expect(screen.getAllByRole('alert')).toHaveLength(2));
    await say(2, 'Drei');
    await waitFor(() => expect(screen.getByText('Belege prüfen (2 offen)')).toBeTruthy());
    expect(screen.getAllByRole('alert').map((a) => a.closest('li')?.id)).toEqual(['pruefen-p1', 'pruefen-p2']);
  });

  it('goes by trying the same payment again, or by closing it', async () => {
    confirmReceipt.mockResolvedValueOnce(refused);
    render(shell(app(), view()));
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: confirmButton }));
    await screen.findByRole('alert');
    await user.click(screen.getByRole('button', { name: 'Meldung schließen' }));
    expect(screen.queryByRole('alert')).toBeNull();
    confirmReceipt.mockResolvedValueOnce(refused);
    await user.click(screen.getByRole('button', { name: confirmButton }));
    await screen.findByRole('alert');
    await user.click(screen.getByRole('button', { name: confirmButton }));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });

  it('a row a whole read took away keeps its message, in the shell', async () => {
    confirmReceipt.mockResolvedValueOnce(refused);
    const base = view();
    const store = app();
    const { rerender } = render(shell(store, base));
    await userEvent.setup().click(screen.getByRole('button', { name: confirmButton }));
    expect((await screen.findByRole('alert')).closest('li')?.id).toBe('pruefen-p1');
    rerender(shell(store, { ...base, readAt: 5, loop: { ...base.loop, open: base.loop.open.slice(1) } }));
    const alert = await screen.findByRole('alert');
    expect(alert.closest('li')).toBeNull();
    expect(alert.textContent).toMatch(/^Zyx Handel/);
  });

  it('a row the filter would hide stays on screen with its message', async () => {
    confirmReceipt.mockResolvedValueOnce(refused);
    const base = view();
    const older = { paymentId: 'p7', bookingDay: '2025-02-01', cents: 100, counterparty: 'Alt', reference: '', state: { state: 'missing' as const } };
    render(shell(app(), { ...base, loop: { ...base.loop, open: [...base.loop.open, older] } }));
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: confirmButton }));
    await screen.findByRole('alert');
    await user.selectOptions(screen.getByLabelText('Jahr der Zahlung'), '2025');
    expect(screen.getByRole('alert').closest('li')?.id).toBe('pruefen-p1');
  });

  it('coming back with an answer on its way: the new panel knows it, and no second click is offered', async () => {
    const answer = later<unknown>();
    confirmReceipt.mockReturnValue(answer.promise);
    const store = app();
    const { rerender } = render(shell(store, view()));
    await userEvent.setup().click(screen.getByRole('button', { name: confirmButton }));
    rerender(shell(store, null));
    // Read while the answer was out: the page still lists the payment.
    rerender(shell(store, view()));
    expect(screen.getByText('Belege prüfen (1 offen)')).toBeTruthy();
    expect(screen.queryByRole('button', { name: confirmButton })).toBeNull();
    answer.resolve({ ok: true, value: change('p1', { state: 'has_receipt' }, 'r1') });
    await waitFor(() => expect(store.checkOutbox.writes).toHaveLength(0));
    expect(screen.getByText('Belege prüfen (1 offen)')).toBeTruthy();
  });

  it('coming back, a refusal brings the row back in the new panel, with its message', async () => {
    const answer = later<unknown>();
    confirmReceipt.mockReturnValue(answer.promise);
    const store = app();
    const { rerender } = render(shell(store, view()));
    await userEvent.setup().click(screen.getByRole('button', { name: confirmButton }));
    rerender(shell(store, null));
    rerender(shell(store, view()));
    answer.resolve(refused);
    expect((await screen.findByRole('alert')).closest('li')?.id).toBe('pruefen-p1');
  });
});

describe('the focus after an answer', () => {
  it('goes to the heading after "no receipt", as the row goes with its buttons', async () => {
    render(<ReceiptChecks initial={view()} focusPaymentId={null} />);
    const user = userEvent.setup();
    await user.click(screen.getAllByRole('button', { name: 'Es gibt keinen Beleg' })[1]);
    await user.type(screen.getByLabelText('Warum es keinen Beleg gibt'), 'Automat');
    await user.click(screen.getByRole('button', { name: 'Antwort ohne Beleg für Abc Laden speichern' }));
    expect(document.activeElement?.tagName).toBe('H2');
  });

  it('goes to the heading after taking an answer back', async () => {
    render(<ReceiptChecks initial={view()} focusPaymentId={null} />);
    const user = userEvent.setup();
    await user.click(screen.getByText(/Ohne Beleg beantwortet/));
    await user.click(screen.getByRole('button', { name: 'Antwort für Parkhaus zurücknehmen' }));
    expect(document.activeElement?.tagName).toBe('H2');
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
    render(<ReceiptChecks initial={withMail()} focusPaymentId={null} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Rechnung.pdf ist nicht die Rechnung' }));
    expect(dismissMail).toHaveBeenCalledWith('mc1');
    expect(await screen.findByText('Kein Beleg gefunden.')).toBeTruthy();
  });

  it('offers neither button without the write permission', () => {
    render(<ReceiptChecks initial={withMail(false)} focusPaymentId={null} />);
    expect(screen.queryByRole('button', { name: /übernehmen/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /nicht die Rechnung/ })).toBeNull();
  });
});

describe('runSummary', () => {
  /** A run of the app's classifying with nothing to decide: it says nothing. */
  const NONE = { pending: 0, byEvidence: 0, byModel: 0, applied: 0, unavailable: false, failedBatches: 0, unanswered: 0, removed: 0, stoppedEarly: false };
  it('says what a run did, in singular and plural', () => {
    expect(runSummary({ classify: NONE, loop: { notified: 1, deferred: 0, open: 1, settled: 0, settledOwnName: 0, retried: 0, mailbox: { status: 'off' as const, missing: [] } }, budgets: { sent: 0, deferred: 0, settled: 0 } })).toBe(
      'Geprüft: 1 neue Benachrichtigung, 1 Zahlung wartet auf einen Beleg.',
    );
    expect(runSummary({ classify: NONE, loop: { notified: 10, deferred: 2, open: 14, settled: 0, settledOwnName: 0, retried: 0, mailbox: { status: 'ok' as const, searched: 3, found: 1 } }, budgets: { sent: 2, deferred: 1, settled: 0 } })).toBe(
      'Geprüft: 10 neue Benachrichtigungen, 14 Zahlungen warten auf einen Beleg, 2 weitere folgen beim nächsten Prüfen. Im Postfach 1 Rechnung gefunden. 2 neue Budgetwarnungen, 1 weitere folgt beim nächsten Prüfen.',
    );
  });
  it('names the messages settled because the money went to one of the own names', () => {
    expect(runSummary({ classify: NONE, loop: { notified: 0, deferred: 0, open: 0, settled: 3, settledOwnName: 2, retried: 0, mailbox: { status: 'off' as const, missing: [] } }, budgets: null })).toMatch(
      /2 Benachrichtigungen erledigt: eigenes Konto/,
    );
  });
  it('names what the app classified first, and says when that part failed', () => {
    expect(runSummary({ classify: { pending: 30, byEvidence: 2, byModel: 18, applied: 15, unavailable: false, failedBatches: 0, unanswered: 0, removed: 0, stoppedEarly: false }, loop: null, budgets: null })).toMatch(
      /^Die App hat 20 Gegenseiten eingeordnet, davon 15 sicher; die übrigen sind Vorschläge\. 10 weitere folgen beim nächsten Prüfen\./,
    );
    expect(runSummary({ classify: null, loop: null, budgets: null })).toMatch(/^Die Gegenseiten konnten nicht eingeordnet werden/);
  });
  it('says which part could not be checked', () => {
    expect(runSummary({ classify: NONE, loop: null, budgets: { sent: 1, deferred: 0, settled: 0 } })).toBe('Die Belege konnten nicht geprüft werden; bitte gleich noch einmal versuchen. 1 neue Budgetwarnung.');
    const failed = runSummary({ classify: NONE, loop: { notified: 0, deferred: 0, open: 0, settled: 0, settledOwnName: 0, retried: 0, mailbox: { status: 'error' as const, code: 'auth_failed' as const, searched: 1, found: 0 } }, budgets: null });
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
