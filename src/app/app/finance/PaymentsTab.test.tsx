// @vitest-environment jsdom
import type { ComponentProps } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { FoundPayment } from '@/lib/tax/payments/service';
import type { OpenPayment, PaymentsView, StatementView } from '@/lib/tax/service';
import PaymentsTab from './PaymentsTab';

afterEach(cleanup);

const account = { id: 'acc-1', label: 'Geschäftskonto', kind: 'bank', isPrivate: false, paymentCount: 3, completeThrough: '2026-01-22', batches: [{ id: 'b-1', format: 'n26_csv', newCount: 3, paymentCount: 3, firstDay: '2026-01-05', lastDay: '2026-01-22', importedAt: '2026-02-01T08:00:00.000Z' }] };
const open = (o: Partial<OpenPayment> = {}): OpenPayment => ({
  id: 'p-1',
  bookingDay: '2026-01-05',
  amountCents: -10_850,
  freeCents: 10_850,
  counterparty: 'Werkzeug Beispiel GmbH',
  reference: 'Bestellung 4711',
  kind: 'spend',
  accountLabel: 'Geschäftskonto',
  check: 'payment_without_document',
  proposals: [],
  namesService: false,
  ...o,
});

function view(payments: Partial<PaymentsView> = {}): StatementView {
  return {
    year: 2026,
    payments: { accounts: [account], yearCount: 3, linkedCount: 1, transferCount: 0, unclassified: [], treatments: [], open: [], estimateProposals: [], payLaterDays: { moved: [], unknown: [], relabelled: [], withoutDetail: 0 }, overridden: [], ruleTransfers: [], ruleTransferCents: 0, reconciliations: [], cancelled: [], receiptTargets: [], invoiceTargets: [], links: [], ...payments },
  } as StatementView;
}

const props = () => ({
  busy: false,
  error: null,
  lastImport: null,
  onAddAccount: vi.fn(),
  onImport: vi.fn(),
  onUndoImport: vi.fn(),
  onTreat: vi.fn(),
  onLink: vi.fn(),
  onUnlink: vi.fn(),
  onAcceptProposals: vi.fn(),
  onTransfer: vi.fn(),
  onNotIncome: vi.fn(),
  onKind: vi.fn(),
  onPayMethod: vi.fn(),
  onAccountPrivate: vi.fn(),
  onSearch: vi.fn<ComponentProps<typeof PaymentsTab>['onSearch']>(async () => ({ ok: true, value: { payments: [], total: 0 } })),
});

const found = (o: Partial<FoundPayment> = {}): FoundPayment => ({
  id: 'f-1',
  bookingDay: '2026-02-03',
  amountCents: -4_999,
  freeCents: 4_999,
  counterparty: 'Versand Beispiel',
  reference: 'Bestellung 1',
  kind: 'spend',
  accountLabel: 'Geschäftskonto',
  target: 'receipt',
  linkedTo: null,
  ...o,
});

describe('PaymentsTab', () => {
  it('without an account it explains what payments are for and offers to create one', async () => {
    const user = userEvent.setup();
    const p = props();
    render(<PaymentsTab view={view({ accounts: [], yearCount: 0, linkedCount: 0 })} {...p} />);
    expect(screen.getByText(/Noch kein Konto angelegt/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Einlesen' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Konto anlegen' }));
    expect(screen.getByRole('alert').textContent).toContain('Namen für das Konto');
    await user.type(screen.getByLabelText('Neues Konto'), 'Karte');
    await user.selectOptions(screen.getByLabelText('Art'), 'card');
    await user.click(screen.getByRole('button', { name: 'Konto anlegen' }));
    expect(p.onAddAccount.mock.calls[0][0]).toEqual({ label: 'Karte', kind: 'card' });
  });

  it('shows how fresh each account is and what each import brought', () => {
    render(<PaymentsTab view={view()} {...props()} />);
    expect(screen.getByText(/3 Zahlungen · vollständig bis 22.01.2026/)).toBeTruthy();
    expect(screen.getByText(/N26 \(CSV\), eingelesen am 01.02.2026: 3 neue von 3 Zahlungen \(05.01.2026 bis 22.01.2026\)/)).toBeTruthy();
  });

  it('reads the chosen file and hands its text to the import; no file, no import', async () => {
    const user = userEvent.setup();
    const p = props();
    render(<PaymentsTab view={view()} {...p} />);
    await user.click(screen.getByRole('button', { name: 'Einlesen' }));
    expect(screen.getByRole('alert').textContent).toContain('Exportdatei auswählen');
    expect(p.onImport).not.toHaveBeenCalled();
    await user.upload(screen.getByLabelText('Datei (CSV oder JSON)'), new File(['a,b\n1,2\n'], 'export.csv', { type: 'text/csv' }));
    await user.click(screen.getByRole('button', { name: 'Einlesen' }));
    await vi.waitFor(() => expect(p.onImport).toHaveBeenCalled());
    expect(p.onImport.mock.calls[0].slice(0, 3)).toEqual(['acc-1', 'a,b\n1,2\n', false]);
    // Limited to the year on screen.
    await user.click(screen.getByLabelText('Nur Zahlungen aus 2026'));
    await user.click(screen.getByRole('button', { name: 'Einlesen' }));
    await vi.waitFor(() => expect(p.onImport).toHaveBeenCalledTimes(2));
    expect(p.onImport.mock.calls[1].slice(0, 3)).toEqual(['acc-1', 'a,b\n1,2\n', true]);
  });

  it('reports an import limited to a year and rows left out because another source covers their days', () => {
    render(
      <PaymentsTab
        view={view()}
        {...props()}
        lastImport={{ batchId: 'b', format: 'enable_banking_json', total: 4, added: 4, alreadyThere: 0, skipped: { other_year: 454, covered_by_other_source: 120 }, autoLinked: 0, cancelledEarlier: 0, releasedLinks: 0, adopted: 0, notices: {}, unknownStatuses: [], unknownMethods: [], detailFilled: 0, onlyYear: 2026, firstDay: '2026-07-01', lastDay: '2026-07-04' }}
      />,
    );
    const status = screen.getByRole('status').textContent;
    expect(status).toContain('Eingelesen (nur 2026): 4 neue Zahlungen');
    expect(status).toContain('454 außerhalb des gewählten Jahres, 120 an Tagen, die eine andere Quelle dieses Kontos schon abdeckt');
  });

  it('reports what an import did, including what was deliberately left out', () => {
    render(
      <PaymentsTab
        view={view()}
        {...props()}
        lastImport={{ batchId: 'b', format: 'paypal_csv', total: 10, added: 7, alreadyThere: 3, skipped: { other_currency: 2, not_completed: 4 }, autoLinked: 1, cancelledEarlier: 0, releasedLinks: 0, adopted: 0, notices: {}, unknownStatuses: [], unknownMethods: [], detailFilled: 0, onlyYear: null, firstDay: null, lastDay: null }}
      />,
    );
    const status = screen.getByRole('status').textContent;
    expect(status).toContain('7 neue Zahlungen, 3 waren schon vorhanden, 1 über die Rechnungsnummer einer Rechnung zugeordnet');
    expect(status).toContain('2 andere Währung, 4 nicht abgeschlossen');
  });

  it('asks once per counterparty', async () => {
    const user = userEvent.setup();
    const p = props();
    render(<PaymentsTab view={view({ unclassified: [{ key: 'vermieter beispiel', label: 'Vermieter Beispiel', count: 2, outCents: 130_000, inCents: 0 }] })} {...p} />);
    const row = screen.getByText('Vermieter Beispiel').closest('li') as HTMLElement;
    expect(row.textContent).toContain('2 Zahlungen · bezahlt 1.300,00 €');
    await user.click(within(row).getByRole('button', { name: 'Privat' }));
    expect(p.onTreat).toHaveBeenCalledWith('Vermieter Beispiel', 'private');
  });

  it('offers proposals with how sure they are, and links only when a person clicks', async () => {
    const user = userEvent.setup();
    const p = props();
    render(
      <PaymentsTab
        view={view({
          open: [
            open({ proposals: [{ target: 'receipt', targetId: 'row-1', label: 'Werkzeugkauf', strength: 'amount_and_date' }] }),
            open({ id: 'p-2', amountCents: 100_000, freeCents: 100_000, counterparty: 'Kundin Beispiel', kind: 'income', check: 'income_without_invoice', proposals: [{ target: 'invoice', targetId: 'inv-1', label: 'Rechnung R-2026-001', strength: 'reference_amount_differs' }] }),
          ],
        })}
        {...p}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Zuordnen: Werkzeugkauf (nur Betrag und Datum passen)' }));
    expect(p.onLink).toHaveBeenLastCalledWith({ paymentId: 'p-1', rowId: 'row-1' });
    await user.click(screen.getByRole('button', { name: 'Zuordnen: Rechnung R-2026-001 (Nummer im Verwendungszweck, Betrag weicht ab)' }));
    expect(p.onLink).toHaveBeenLastCalledWith({ paymentId: 'p-2', invoiceId: 'inv-1' });
    await user.click(screen.getByRole('button', { name: 'Keine Einnahme (Erstattung oder Umbuchung)' }));
    expect(p.onNotIncome.mock.calls[0][0].id).toBe('p-2');
  });

  it('lists links and answers so each can be taken back', async () => {
    const user = userEvent.setup();
    const p = props();
    render(
      <PaymentsTab
        view={view({
          links: [{ linkId: 'l-1', paymentId: 'p-1', bookingDay: '2026-01-20', cents: 100_000, counterparty: 'Kundin Beispiel', target: 'invoice', rowId: null, targetLabel: 'Rechnung R-2026-001', method: 'reference', counts: true }],
          treatments: [{ key: 'vermieter beispiel', label: 'Vermieter Beispiel', treatment: 'private' }],
        })}
        {...p}
      />,
    );
    expect(screen.getByText(/über die Rechnungsnummer/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Lösen' }));
    expect(p.onUnlink).toHaveBeenCalledWith('l-1');
    await user.click(screen.getByRole('button', { name: 'Antwort zurücknehmen' }));
    expect(p.onTreat).toHaveBeenCalledWith('Vermieter Beispiel', null);
  });

  it('links by hand: a chosen receipt, optionally with a part of the amount, checked before anything is sent', async () => {
    const user = userEvent.setup();
    const p = props();
    const receiptTargets = [{ id: 'r-9', label: 'Bestellung 4711', day: '2025-12-28', amountCents: 10_000, linkedCents: 0 }];
    render(<PaymentsTab view={view({ open: [open()], receiptTargets })} {...p} />);
    // The picker is drawn only once it is asked for.
    expect(screen.queryByLabelText('Beleg von Hand wählen')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Von Hand zuordnen' }));
    await user.click(screen.getByRole('button', { name: 'Zuordnen' }));
    expect(screen.getByRole('alert').textContent).toContain('Bitte einen Beleg');
    await user.selectOptions(screen.getByLabelText('Beleg von Hand wählen'), 'r:r-9');
    await user.type(screen.getByLabelText(/Teilbetrag/), '200');
    await user.click(screen.getByRole('button', { name: 'Zuordnen' }));
    expect(screen.getByRole('alert').textContent).toContain('noch offen');
    expect(p.onLink).not.toHaveBeenCalled();
    await user.clear(screen.getByLabelText(/Teilbetrag/));
    await user.type(screen.getByLabelText(/Teilbetrag/), '100');
    await user.click(screen.getByRole('button', { name: 'Zuordnen' }));
    expect(p.onLink).toHaveBeenCalledWith({ paymentId: 'p-1', rowId: 'r-9', cents: 10_000 });
  });

  it('money received is linked by hand to an invoice with something open; without an amount all that is open', async () => {
    const user = userEvent.setup();
    const p = props();
    const income = open({ amountCents: 50_000, freeCents: 50_000, kind: 'income', check: 'income_without_invoice' });
    render(<PaymentsTab view={view({ open: [income], invoiceTargets: [{ id: 'i-1', label: 'Rechnung R-2026-050', openCents: 20_000 }], receiptTargets: [{ id: 'r-9', label: 'x', day: null, amountCents: null, linkedCents: 0 }] })} {...p} />);
    await user.click(screen.getByRole('button', { name: 'Von Hand zuordnen' }));
    // Money in goes on an invoice, or on a receipt as money back: both are offered, grouped.
    const picker = screen.getByLabelText('Rechnung oder Beleg (Erstattung) von Hand wählen');
    await user.selectOptions(picker, 'i:i-1');
    await user.click(screen.getByRole('button', { name: 'Zuordnen' }));
    expect(p.onLink).toHaveBeenCalledWith({ paymentId: 'p-1', invoiceId: 'i-1' });
    await user.selectOptions(picker, 'r:r-9');
    await user.click(screen.getByRole('button', { name: 'Zuordnen' }));
    expect(p.onLink).toHaveBeenLastCalledWith({ paymentId: 'p-1', rowId: 'r-9' });
  });

  it('a payment without a name can be marked private, and what was re-labelled can be put back', async () => {
    const user = userEvent.setup();
    const p = props();
    const overridden = [{ id: 'p-7', bookingDay: '2026-01-09', amountCents: -1_230, counterparty: '', kind: 'private' as const }];
    render(<PaymentsTab view={view({ open: [open({ counterparty: '' })], overridden })} {...p} />);
    expect(screen.queryByRole('button', { name: 'Gegenseite ist privat' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Diese Zahlung ist privat' }));
    expect(p.onKind).toHaveBeenCalledWith('p-1', 'private');
    const section = screen.getByRole('region', { name: 'Umgewidmete Zahlungen' });
    expect(section.textContent).toContain('privat');
    await user.click(within(section).getByRole('button', { name: 'Zurücksetzen' }));
    expect(p.onKind).toHaveBeenCalledWith('p-7', null);
  });

  it('with many open payments the list of receipts is drawn once, for the payment whose picker is open', async () => {
    const user = userEvent.setup();
    const many = Array.from({ length: 40 }, (_, i) => open({ id: `p-${i}`, counterparty: `Firma Beispiel ${i}` }));
    const receiptTargets = Array.from({ length: 30 }, (_, i) => ({ id: `r-${i}`, label: `Beleg ${i}`, day: '2026-01-02', amountCents: 1_000, linkedCents: i === 0 ? 400 : 0 }));
    const { container } = render(<PaymentsTab view={view({ open: many, receiptTargets })} {...props()} />);
    // Before: 40 pickers of 30 receipts each. Now none until one is opened, and one at a time.
    expect(container.querySelectorAll('option[value^="r:"]').length).toBe(0);
    const openers = screen.getAllByRole('button', { name: 'Von Hand zuordnen' });
    expect(openers.length).toBe(40);
    await user.click(openers[3]);
    expect(container.querySelectorAll('option[value^="r:"]').length).toBe(30);
    expect(openers[3].getAttribute('aria-expanded')).toBe('true');
    await user.click(openers[7]);
    expect(container.querySelectorAll('option[value^="r:"]').length).toBe(30);
    expect(openers[3].getAttribute('aria-expanded')).toBe('false');
    await user.click(openers[7]);
    expect(container.querySelectorAll('option[value^="r:"]').length).toBe(0);
  });

  it('without anything to link to, no picker is offered', () => {
    render(<PaymentsTab view={view({ open: [open()] })} {...props()} />);
    expect(screen.queryByRole('button', { name: 'Von Hand zuordnen' })).toBeNull();
  });

  it('offers a payment for a receipt on an estimated amount; one click takes one, one click takes all unambiguous ones', async () => {
    const user = userEvent.setup();
    const p = props();
    const proposal = { paymentId: 'p-1', rowId: 'r-1', receiptLabel: 'Editor Beispiel März', receiptDay: '2026-03-02', estimateCents: 2_000, bookingDay: '2026-03-03', paidCents: 2_075, counterparty: 'Editor Beispiel', accountLabel: 'Später zahlen', unambiguous: true, severalReceipts: false };
    const estimateProposals = [proposal, { ...proposal, paymentId: 'p-2', rowId: 'r-2', receiptLabel: 'Editor Beispiel April', receiptDay: '2026-04-02', bookingDay: '2026-04-03' }, { ...proposal, paymentId: 'p-3', rowId: 'r-3', receiptLabel: 'Hosting Beispiel', unambiguous: false }];
    render(<PaymentsTab view={view({ estimateProposals })} {...p} />);
    const section = screen.getByRole('region', { name: 'Vorschläge für geschätzte Belege' });
    const first = within(section).getByText(/Editor Beispiel März/).closest('li') as HTMLElement;
    expect(first.textContent).toContain('geschätzt 20,00 € · bezahlt 20,75 € am 03.03.2026 an Editor Beispiel · Später zahlen');
    expect((within(section).getByText(/Hosting Beispiel/).closest('li') as HTMLElement).textContent).toContain('mehrdeutig, bitte einzeln prüfen');

    // Nothing is linked by drawing the list.
    expect(p.onLink).not.toHaveBeenCalled();
    // One row: the same accept path as the bulk action, for the one pair, so it is recorded as an accepted proposal.
    await user.click(within(first).getByRole('button', { name: 'Übernehmen' }));
    expect(p.onAcceptProposals).toHaveBeenLastCalledWith([{ paymentId: 'p-1', rowId: 'r-1' }], false);
    expect(p.onLink).not.toHaveBeenCalled();
    p.onAcceptProposals.mockClear();

    // The bulk action counts the unambiguous ones only, asks first, and sends no list: the server works it out again.
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    await user.click(within(section).getByRole('button', { name: 'Alle 2 eindeutigen Vorschläge übernehmen' }));
    expect(p.onAcceptProposals).not.toHaveBeenCalled();
    await user.click(within(section).getByRole('button', { name: 'Alle 2 eindeutigen Vorschläge übernehmen' }));
    // What is sent is the list the dialog counted: the two unambiguous pairs, not the ambiguous third.
    expect(p.onAcceptProposals).toHaveBeenCalledWith([{ paymentId: 'p-1', rowId: 'r-1' }, { paymentId: 'p-2', rowId: 'r-2' }], true);
    expect(confirm.mock.calls[0][0]).toContain('2 eindeutige Vorschläge übernehmen?');
    confirm.mockRestore();
  });

  it('while the bulk accept runs the button says so and cannot be pressed again; it comes back when the answer is in', async () => {
    const user = userEvent.setup();
    const p = props();
    const proposal = { paymentId: 'p-1', rowId: 'r-1', receiptLabel: 'Editor Beispiel', receiptDay: '2026-03-02', estimateCents: 2_000, bookingDay: '2026-03-03', paidCents: 2_075, counterparty: '', accountLabel: 'Später zahlen', unambiguous: true, severalReceipts: false };
    const shown = view({ estimateProposals: [proposal, { ...proposal, paymentId: 'p-2', rowId: 'r-2' }] });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { rerender } = render(<PaymentsTab view={shown} {...p} />);
    await user.click(screen.getByRole('button', { name: 'Alle 2 eindeutigen Vorschläge übernehmen' }));
    // The parent turns `busy` on a moment later; the button is locked from the press itself.
    const running = screen.getByRole('button', { name: 'Übernimmt 2 Vorschläge …' }) as HTMLButtonElement;
    expect(running.disabled).toBe(true);
    expect(screen.getByRole('status').textContent).toContain('ein zweiter Klick ist nicht nötig');
    await user.click(running);
    expect(p.onAcceptProposals).toHaveBeenCalledTimes(1);
    rerender(<PaymentsTab view={shown} {...p} busy />);
    expect((screen.getByRole('button', { name: 'Übernimmt 2 Vorschläge …' }) as HTMLButtonElement).disabled).toBe(true);
    // The answer is in (here: a failure, the proposals are still shown): the button is usable again.
    rerender(<PaymentsTab view={shown} {...p} busy={false} />);
    expect((screen.getByRole('button', { name: 'Alle 2 eindeutigen Vorschläge übernehmen' }) as HTMLButtonElement).disabled).toBe(false);
    confirm.mockRestore();
  });

  it('one payment for two receipts is shown for both as needing a hand: no accept button, not in the bulk count', () => {
    const proposal = { paymentId: 'p-1', rowId: 'r-1', receiptLabel: 'Hosting Beispiel A', receiptDay: '2026-03-02', estimateCents: 1_000, bookingDay: '2026-03-03', paidCents: 1_948, counterparty: 'Hosting Beispiel', accountLabel: 'Später zahlen', unambiguous: false, severalReceipts: true };
    render(<PaymentsTab view={view({ estimateProposals: [proposal, { ...proposal, rowId: 'r-2', receiptLabel: 'Hosting Beispiel B', estimateCents: 950 }] })} {...props()} />);
    const section = screen.getByRole('region', { name: 'Vorschläge für geschätzte Belege' });
    expect(within(section).getAllByText(/eine Zahlung für mehrere Belege\?/).length).toBe(2);
    expect(within(section).queryByRole('button', { name: 'Übernehmen' })).toBeNull();
    expect(within(section).queryByRole('button', { name: /eindeutigen Vorschl/ })).toBeNull();
  });

  it('only ambiguous proposals: each can be taken, there is nothing to take in bulk; no proposals, no section', () => {
    const proposal = { paymentId: 'p-1', rowId: 'r-1', receiptLabel: 'Editor Beispiel', receiptDay: '2026-03-02', estimateCents: 2_000, bookingDay: '2026-03-03', paidCents: 2_075, counterparty: '', accountLabel: 'Später zahlen', unambiguous: false, severalReceipts: false };
    const { unmount } = render(<PaymentsTab view={view({ estimateProposals: [proposal] })} {...props()} />);
    expect(screen.getByRole('button', { name: 'Übernehmen' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /eindeutigen Vorschl/ })).toBeNull();
    unmount();
    render(<PaymentsTab view={view()} {...props()} />);
    expect(screen.queryByRole('region', { name: 'Vorschläge für geschätzte Belege' })).toBeNull();
  });

  it('says how many payments are transfers between own accounts, and names how a link came about', () => {
    render(
      <PaymentsTab
        view={view({
          transferCount: 12,
          links: [{ linkId: 'l-2', paymentId: 'p-1', bookingDay: '2026-03-03', cents: 2_075, counterparty: 'Editor Beispiel', target: 'receipt', rowId: 'row-march', targetLabel: 'Editor Beispiel März', method: 'estimate', counts: false }],
        })}
        {...props()}
      />,
    );
    expect(screen.getByText(/12 Umbuchungen zwischen eigenen Konten, nach denen nicht gefragt wird/)).toBeTruthy();
    expect(screen.getByText(/Vorschlag, von dir übernommen · zählt nicht doppelt/)).toBeTruthy();
  });

  it('a linked payment leads to its receipt in the table; one linked to an issued invoice has no such link', () => {
    render(
      <PaymentsTab
        view={view({
          links: [
            { linkId: 'l-2', paymentId: 'p-1', bookingDay: '2026-03-03', cents: 2_075, counterparty: 'Editor Beispiel', target: 'receipt', rowId: 'row march/1', targetLabel: 'Editor Beispiel März', method: 'manual', counts: true },
            { linkId: 'l-3', paymentId: 'p-2', bookingDay: '2026-01-20', cents: 100_000, counterparty: 'Kundin Beispiel', target: 'invoice', rowId: null, targetLabel: 'Rechnung R-2026-001', method: 'reference', counts: true },
          ],
        })}
        {...props()}
      />,
    );
    const link = screen.getByRole('link', { name: 'Editor Beispiel März' });
    expect(link.getAttribute('href')).toBe('/app/dashboard?beleg=row%20march%2F1');
    expect(screen.queryByRole('link', { name: 'Rechnung R-2026-001' })).toBeNull();
  });

  it('reports the rows a pay-later list left out in plain words', () => {
    render(
      <PaymentsTab
        view={view()}
        {...props()}
        lastImport={{ batchId: 'b', format: 'klarna_csv', total: 5, added: 5, alreadyThere: 0, skipped: { cancelled: 2, duplicate_row: 1, zero_amount: 1 }, autoLinked: 0, cancelledEarlier: 2, releasedLinks: 1, adopted: 1, notices: { part_refunded: 1, unknown_status: 1 }, unknownStatuses: ['Angefochten'], unknownMethods: [], detailFilled: 0, onlyYear: null, firstDay: null, lastDay: null }}
      />,
    );
    const status = screen.getByRole('status').textContent;
    expect(status).toContain('2 storniert oder vollständig erstattet, 1 doppelt in der Datei, 1 ohne Betrag');
    expect(status).toContain('1 schon vorhandene an ihrer neuen Nummer wiedererkannt');
    expect(status).toContain('2 früher eingelesene Käufe sind laut dieser Datei storniert oder vollständig erstattet und zählen nicht mehr; 1 Zuordnung wurde gelöst, siehe „Stornierte Käufe“');
    expect(status).toContain('Bitte ansehen: 1 teilweise erstattet');
    // A wording the reader did not know is read as a purchase and named, never dropped in silence.
    expect(status).toContain('1 mit unbekanntem Status (als Kauf eingelesen');
    expect(status).toContain('Unbekannte Statusangaben: „Angefochten“.');
  });

  it('lists what the funding rule treats as a transfer, with count and sum, and each can be made a payment of its own', async () => {
    const user = userEvent.setup();
    const p = props();
    const ruleTransfers = [
      { id: 't-1', bookingDay: '2026-03-28', amountCents: -3_615, counterparty: 'Später Beispiel Bank', reference: 'Sammelabrechnung', accountLabel: 'Geschäftskonto', hasTwin: false, linkedTo: [] },
      { id: 't-2', bookingDay: '2026-03-12', amountCents: -1_999, counterparty: 'Geldbörse Beispiel', reference: '', accountLabel: 'Geschäftskonto', hasTwin: true, linkedTo: ['Einkauf Laden'] },
    ];
    render(<PaymentsTab view={view({ ruleTransfers, ruleTransferCents: 5_614 })} {...p} />);
    const section = screen.getByRole('region', { name: 'Umbuchungen zwischen eigenen Konten' });
    // Collapsed: the summary carries count and sum.
    expect(within(section).getByText('2 Zahlungen als Umbuchung behandelt, zusammen 56,14 €')).toBeTruthy();
    // A transfer that is linked says to which receipt: a linked payment appears in no other list.
    expect((within(section).getByText(/Geldbörse Beispiel/).closest('li') as HTMLElement).textContent).toContain('der Kauf dazu steht in der Liste des Dienstes · zugeordnet zu: Einkauf Laden');
    const row = within(section).getByText(/Später Beispiel Bank/).closest('li') as HTMLElement;
    await user.click(within(row).getByRole('button', { name: 'Kein Übertrag, eine eigene Zahlung' }));
    expect(p.onTransfer).toHaveBeenCalledWith('t-1', false);
  });

  it('an open payment that names a held service can be called a transfer; any other open payment cannot', async () => {
    const user = userEvent.setup();
    const p = props();
    render(<PaymentsTab view={view({ open: [open({ id: 'p-5', counterparty: 'Später Beispiel Bank', namesService: true }), open({ id: 'p-6', counterparty: 'Werkzeug Beispiel GmbH' })] })} {...p} />);
    const buttons = screen.getAllByRole('button', { name: 'Übertrag zwischen eigenen Konten' });
    expect(buttons.length).toBe(1);
    await user.click(buttons[0]);
    expect(p.onTransfer).toHaveBeenCalledWith('p-5', true);
  });

  it('sets what was collected against what the service’s list states, and calls out a year that does not fit', () => {
    const months = [{ month: '2026-03', collectedCents: 4_065, listedCents: 3_615, differenceCents: 450, runningCents: 450 }];
    const fits = { service: 'paypal', serviceKind: 'wallet' as const, accountLabels: ['Geldbörse'], months: [], collectedCents: 1_999, listedCents: 1_999, differenceCents: 0, reconciles: true, toleranceCents: 100 };
    const fromBalance = { ...fits, accountLabels: ['Zweite Geldbörse'], listedCents: 9_999, differenceCents: -8_000 };
    const off = { service: 'klarna', serviceKind: 'pay_later' as const, accountLabels: ['Später zahlen'], months, collectedCents: 4_065, listedCents: 3_615, differenceCents: 450, reconciles: false, toleranceCents: 100 };
    render(<PaymentsTab view={view({ reconciliations: [fits, fromBalance, off] })} {...props()} />);
    const section = screen.getByRole('region', { name: 'Umbuchungen zwischen eigenen Konten' });
    expect(within(section).getByText(/PayPal \(Geldbörse\): vom Bankkonto eingezogen 19,99 €, Käufe laut Liste 19,99 €/).textContent).toContain('Das passt zusammen.');
    // A wallet that collected less than it lists is no alarm, and says why.
    expect(within(section).getByText(/PayPal \(Zweite Geldbörse\)/).textContent).toContain('bei einem Guthabenkonto üblich');
    const alert = within(section).getByRole('alert');
    expect(alert.textContent).toContain('Klarna (Später zahlen): vom Bankkonto eingezogen 40,65 €, Käufe laut Liste 36,15 €, Differenz 4,50 € mehr eingezogen als gelistet.');
    expect(alert.textContent).toContain('Das passt nicht zusammen (Toleranz 1,00 €)');
    expect(alert.textContent).toContain('Gebühren oder Zinsen');
    const cells = within(within(section).getByRole('table')).getAllByRole('cell').map((c) => c.textContent);
    expect(cells).toEqual(['03/2026', '40,65 €', '36,15 €', '4,50 €', '4,50 €']);
  });

  it('names the purchases a later list cancelled and the receipt that lost its payment', () => {
    const cancelled = [{ id: 'c-1', bookingDay: '2026-03-03', amountCents: -2_075, counterparty: 'Editor Beispiel', accountLabel: 'Später zahlen', releasedFrom: ['Editor Beispiel März'] }];
    render(<PaymentsTab view={view({ cancelled })} {...props()} />);
    const section = screen.getByRole('region', { name: 'Stornierte Käufe' });
    expect(section.textContent).toContain('03.03.2026 Editor Beispiel 20,75 €');
    expect(section.textContent).toContain('Zuordnung gelöst von: Editor Beispiel März');
  });

  it('the picker says which receipt already carries a payment, and re-labelled transfers read in plain words', async () => {
    const user = userEvent.setup();
    const receiptTargets = [{ id: 'r-1', label: 'Einkauf Laden', day: '2026-03-11', amountCents: 1_999, linkedCents: 1_999 }];
    const overridden = [
      { id: 'p-8', bookingDay: '2026-03-28', amountCents: -3_615, counterparty: 'Später Beispiel Bank', kind: 'spend' as const },
      { id: 'p-9', bookingDay: '2026-04-28', amountCents: -900, counterparty: 'Später Beispiel Bank', kind: 'own_transfer' as const },
    ];
    render(<PaymentsTab view={view({ open: [open()], receiptTargets, overridden })} {...props()} />);
    await user.click(screen.getByRole('button', { name: 'Von Hand zuordnen' }));
    expect(screen.getByRole('option', { name: /Einkauf Laden \(19,99 €\), schon zugeordnet 19,99 €/ })).toBeTruthy();
    const section = screen.getByRole('region', { name: 'Umgewidmete Zahlungen' });
    expect(section.textContent).toContain('eigene Zahlung, kein Übertrag');
    expect(section.textContent).toContain('Übertrag zwischen eigenen Konten');
  });

  it('a refund asks for the receipt it belongs to', () => {
    render(<PaymentsTab view={view({ open: [open({ amountCents: 750, freeCents: 750, kind: 'refund', check: 'refund_without_receipt' })] })} {...props()} />);
    expect(screen.getByText(/Erstattung: dem Beleg zuordnen/)).toBeTruthy();
  });

  it('a whole account can be called private after a confirmation, and that can be taken back', async () => {
    const user = userEvent.setup();
    const p = props();
    const confirm = vi.spyOn(window, 'confirm');
    confirm.mockReturnValueOnce(false);
    const { rerender } = render(<PaymentsTab view={view()} {...p} />);
    await user.click(screen.getByRole('button', { name: 'Ganzes Konto ist privat' }));
    expect(p.onAccountPrivate).not.toHaveBeenCalled();
    confirm.mockReturnValueOnce(true);
    await user.click(screen.getByRole('button', { name: 'Ganzes Konto ist privat' }));
    expect(p.onAccountPrivate).toHaveBeenCalledWith(expect.objectContaining({ id: 'acc-1' }), true);
    confirm.mockRestore();

    rerender(<PaymentsTab view={view({ accounts: [{ ...account, isPrivate: true }] })} {...p} />);
    expect(screen.getByText(/privat: nach seinen Zahlungen wird nicht gefragt/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Wieder prüfen' }));
    expect(p.onAccountPrivate).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'acc-1' }), false);
  });

  it('a counterparty can be answered as mixed', async () => {
    const user = userEvent.setup();
    const p = props();
    render(<PaymentsTab view={view({ unclassified: [{ key: 'versand beispiel', label: 'Versand Beispiel', count: 4, outCents: 20_000, inCents: 0 }] })} {...p} />);
    await user.click(screen.getByRole('button', { name: 'Teils, teils' }));
    expect(p.onTreat).toHaveBeenCalledWith('Versand Beispiel', 'mixed');
  });

  it('one payment of an unanswered counterparty is linked by hand without answering for the others, and the list follows the statement', async () => {
    const user = userEvent.setup();
    const p = props();
    const unclassified = [{ key: 'versand beispiel', label: 'Versand Beispiel', count: 2, outCents: 9_998, inCents: 0 }];
    const receiptTargets = [{ id: 'r-1', label: 'Bürostuhl', day: '2026-02-01', amountCents: 4_999, linkedCents: 0 }];
    p.onSearch.mockResolvedValueOnce({ ok: true, value: { payments: [found(), found({ id: 'f-2', bookingDay: '2026-03-03' })], total: 2 } });
    const first = view({ unclassified, receiptTargets });
    const { rerender } = render(<PaymentsTab view={first} {...p} />);
    await user.click(screen.getByRole('button', { name: 'Zahlungen ansehen' }));
    expect(p.onSearch).toHaveBeenCalledWith({ counterpartyKey: 'versand beispiel' });
    const list = await screen.findByRole('list', { name: 'Gefundene Zahlungen' });
    expect(within(list).getAllByRole('listitem').length).toBe(2);
    // Each payment's button says which payment it is for.
    await user.click(within(list).getByRole('button', { name: 'Beleg wählen für 03.02.2026 Versand Beispiel 49,99 €' }));
    await user.selectOptions(screen.getByLabelText('Beleg von Hand wählen'), 'r:r-1');
    await user.click(within(list).getByRole('button', { name: 'Zuordnen' }));
    expect(p.onLink).toHaveBeenCalledWith({ paymentId: 'f-1', rowId: 'r-1' });
    expect(p.onTreat).not.toHaveBeenCalled();

    // The statement that comes back searches again: the linked payment is gone, the other one is still there.
    p.onSearch.mockResolvedValueOnce({ ok: true, value: { payments: [found({ id: 'f-2', bookingDay: '2026-03-03' })], total: 1 } });
    rerender(<PaymentsTab view={view({ unclassified: [{ ...unclassified[0], count: 1 }], receiptTargets })} {...p} />);
    // While it searches again the last results stay on screen, the open picker included.
    expect(screen.getByRole('status').textContent).toBe('Sucht …');
    expect(screen.getByLabelText('Beleg von Hand wählen')).toBeTruthy();
    await vi.waitFor(() => expect(within(screen.getByRole('list', { name: 'Gefundene Zahlungen' })).getAllByRole('listitem').length).toBe(1));
    expect(p.onSearch).toHaveBeenCalledTimes(2);
  });

  it('searches any payment by text, says when more were found than shown, and says when the search failed', async () => {
    const user = userEvent.setup();
    const p = props();
    render(<PaymentsTab view={view({ receiptTargets: [] })} {...p} />);
    const box = screen.getByLabelText('Andere Zahlung suchen und von Hand zuordnen');
    await user.type(box, 'x');
    expect(screen.getByText('Bitte mindestens zwei Zeichen.')).toBeTruthy();
    expect(box.getAttribute('aria-describedby')).toBeTruthy();
    const many = Array.from({ length: 100 }, (_, i) => found({ id: `f-${i}`, kind: i === 0 ? 'private' : 'spend' }));
    p.onSearch.mockResolvedValueOnce({ ok: true, value: { payments: many, total: 140 } });
    await user.type(box, 'y');
    await user.click(screen.getByRole('button', { name: 'Suchen' }));
    expect(p.onSearch).toHaveBeenCalledWith({ text: 'xy' });
    expect(await screen.findByText(/140 gefunden, die ersten 100 werden gezeigt/)).toBeTruthy();
    // The notice is not one of the payments.
    expect(within(screen.getByRole('list', { name: 'Gefundene Zahlungen' })).getAllByRole('listitem').length).toBe(100);
    expect(screen.getAllByText(/· privat/).length).toBe(1);
    // No receipt to link to: it says so instead of an empty picker.
    await user.click(screen.getAllByRole('button', { name: /^Beleg wählen für/ })[0]);
    expect(screen.getByText('Kein Beleg aus diesem oder dem Vorjahr vorhanden.')).toBeTruthy();

    // Pressing "Suchen" again with the same words searches again.
    p.onSearch.mockResolvedValueOnce({ ok: false, error: 'failed' });
    await user.click(screen.getByRole('button', { name: 'Suchen' }));
    expect((await screen.findByRole('alert')).textContent).toContain('konnten nicht geladen werden');
    expect(p.onSearch).toHaveBeenCalledTimes(2);
    // A failed search offers to try again, and trying again searches again.
    p.onSearch.mockResolvedValueOnce({ ok: true, value: { payments: [], total: 0 } });
    await user.click(screen.getByRole('button', { name: 'Erneut versuchen' }));
    expect(await screen.findByText('Keine Zahlung aus 2026 mit offenem Betrag.')).toBeTruthy();
    expect(p.onSearch).toHaveBeenCalledTimes(3);
  });

  it('money in found by the search goes on an invoice or, as money back, on a receipt; one already on an invoice stays with invoices', async () => {
    const user = userEvent.setup();
    const p = props();
    const targets = { invoiceTargets: [{ id: 'i-1', label: 'Rechnung R-2026-050', openCents: 2_000 }], receiptTargets: [{ id: 'r-1', label: 'Kabel', day: '2026-02-01', amountCents: 2_000, linkedCents: 0 }] };
    p.onSearch.mockResolvedValueOnce({
      ok: true,
      value: { payments: [found({ id: 'f-in', amountCents: 2_000, freeCents: 2_000, kind: 'income', target: 'invoice' }), found({ id: 'f-inv', amountCents: 3_000, freeCents: 1_000, kind: 'income', target: 'invoice', linkedTo: 'invoice' })], total: 2 },
    });
    render(<PaymentsTab view={view(targets)} {...p} />);
    await user.type(screen.getByLabelText('Andere Zahlung suchen und von Hand zuordnen'), 'Versand');
    await user.click(screen.getByRole('button', { name: 'Suchen' }));
    const choosers = await screen.findAllByRole('button', { name: /^Rechnung wählen für/ });
    await user.click(choosers[0]);
    expect(screen.getByLabelText('Rechnung oder Beleg (Erstattung) von Hand wählen')).toBeTruthy();
    await user.click(choosers[0]);
    await user.click(choosers[1]);
    expect(screen.getByLabelText('Rechnung von Hand wählen')).toBeTruthy();
  });

  it('lists pay-later purchases whose year moves or whose collection is unknown, and a person says how one was paid or takes it back', async () => {
    const user = userEvent.setup();
    const p = props();
    const entry = (o: Record<string, unknown>) => ({ id: 'k-1', bookingDay: '2025-12-10', taxDay: '2026-01-08', amountCents: -4_000, counterparty: 'Laden Beispiel', accountLabel: 'Später zahlen', method: 'checkout' as const, byPerson: false, linkedTo: ['Lampe'], ...o });
    render(
      <PaymentsTab
        view={view({
          payLaterDays: {
            moved: [entry({})],
            unknown: [entry({ id: 'k-2', counterparty: 'Kiosk Beispiel', taxDay: '2025-12-10', linkedTo: [] })],
            relabelled: [entry({ id: 'k-3', counterparty: 'Café Beispiel', method: 'card', byPerson: true, taxDay: '2025-12-12', bookingDay: '2025-12-12' })],
            withoutDetail: 2,
          },
        })}
        {...p}
      />,
    );
    const section = screen.getByRole('region', { name: 'Tag der Zahlung bei Käufen über den Später-bezahlen-Dienst' });
    expect(within(section).getByText(/zählt am 08\.01\.2026/)).toBeTruthy();
    expect(within(section).getAllByText(/zugeordnet: Lampe/).length).toBe(2);
    expect(within(section).getByText('Einzugstag unbekannt')).toBeTruthy();
    expect(within(section).getByText(/2 Käufe wurden eingelesen, bevor die Zahlungsart/)).toBeTruthy();
    // Each button names the purchase it changes.
    await user.click(within(section).getByRole('button', { name: 'Mit der Karte bezahlt: Laden Beispiel, 10.12.2025, 40,00 €' }));
    expect(p.onPayMethod).toHaveBeenLastCalledWith('k-1', 'card');
    await user.click(within(section).getByRole('button', { name: /^Mit der Karte bezahlt: Kiosk Beispiel/ }));
    expect(p.onPayMethod).toHaveBeenLastCalledWith('k-2', 'card');
    expect(within(section).getAllByText(/Später zahlen ·/).length).toBe(3);
    // A purchase a person said was paid by card can be said to be on invoice, or put back.
    await user.click(within(section).getByRole('button', { name: /^Auf Rechnung bezahlt: Café Beispiel/ }));
    expect(p.onPayMethod).toHaveBeenLastCalledWith('k-3', 'checkout');
    await user.click(within(section).getByRole('button', { name: /^Zurücksetzen: Café Beispiel/ }));
    expect(p.onPayMethod).toHaveBeenLastCalledWith('k-3', null);
  });

  it('shows no pay-later section when nothing needs a look', () => {
    render(<PaymentsTab view={view()} {...props()} />);
    expect(screen.queryByRole('region', { name: 'Tag der Zahlung bei Käufen über den Später-bezahlen-Dienst' })).toBeNull();
  });
});
