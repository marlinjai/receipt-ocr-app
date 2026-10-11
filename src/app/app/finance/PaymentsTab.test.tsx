// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { OpenPayment, PaymentsView, StatementView } from '@/lib/tax/service';
import PaymentsTab from './PaymentsTab';

afterEach(cleanup);

const account = { id: 'acc-1', label: 'Geschäftskonto', kind: 'bank', paymentCount: 3, completeThrough: '2026-01-22', batches: [{ id: 'b-1', format: 'n26_csv', newCount: 3, paymentCount: 3, firstDay: '2026-01-05', lastDay: '2026-01-22', importedAt: '2026-02-01T08:00:00.000Z' }] };
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
  ...o,
});

function view(payments: Partial<PaymentsView> = {}): StatementView {
  return {
    year: 2026,
    payments: { accounts: [account], yearCount: 3, linkedCount: 1, transferCount: 0, unclassified: [], treatments: [], open: [], estimateProposals: [], overridden: [], receiptTargets: [], invoiceTargets: [], links: [], ...payments },
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
  onNotIncome: vi.fn(),
  onKind: vi.fn(),
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
    expect(p.onImport.mock.calls[0].slice(0, 2)).toEqual(['acc-1', 'a,b\n1,2\n']);
  });

  it('reports what an import did, including what was deliberately left out', () => {
    render(
      <PaymentsTab
        view={view()}
        {...props()}
        lastImport={{ batchId: 'b', format: 'paypal_csv', total: 10, added: 7, alreadyThere: 3, skipped: { other_currency: 2, not_completed: 4 }, autoLinked: 1, firstDay: null, lastDay: null }}
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
          links: [{ linkId: 'l-1', paymentId: 'p-1', bookingDay: '2026-01-20', cents: 100_000, counterparty: 'Kundin Beispiel', target: 'invoice', targetLabel: 'Rechnung R-2026-001', method: 'reference' }],
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
    const receiptTargets = [{ id: 'r-9', label: 'Bestellung 4711', day: '2025-12-28', amountCents: 10_000 }];
    render(<PaymentsTab view={view({ open: [open()], receiptTargets })} {...p} />);
    // The picker is drawn only once it is asked for.
    expect(screen.queryByLabelText('Beleg von Hand wählen')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Von Hand zuordnen' }));
    await user.click(screen.getByRole('button', { name: 'Zuordnen' }));
    expect(screen.getByRole('alert').textContent).toContain('Bitte einen Beleg');
    await user.selectOptions(screen.getByLabelText('Beleg von Hand wählen'), 'r-9');
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
    render(<PaymentsTab view={view({ open: [income], invoiceTargets: [{ id: 'i-1', label: 'Rechnung R-2026-050', openCents: 20_000 }], receiptTargets: [{ id: 'r-9', label: 'x', day: null, amountCents: null }] })} {...p} />);
    await user.click(screen.getByRole('button', { name: 'Von Hand zuordnen' }));
    expect(screen.queryByLabelText('Beleg von Hand wählen')).toBeNull();
    await user.selectOptions(screen.getByLabelText('Rechnung von Hand wählen'), 'i-1');
    await user.click(screen.getByRole('button', { name: 'Zuordnen' }));
    expect(p.onLink).toHaveBeenCalledWith({ paymentId: 'p-1', invoiceId: 'i-1' });
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
    const receiptTargets = Array.from({ length: 30 }, (_, i) => ({ id: `r-${i}`, label: `Beleg ${i}`, day: '2026-01-02', amountCents: 1_000 }));
    const { container } = render(<PaymentsTab view={view({ open: many, receiptTargets })} {...props()} />);
    // Before: 40 pickers of 30 receipts each. Now none until one is opened, and one at a time.
    expect(container.querySelectorAll('option[value^="r-"]').length).toBe(0);
    const openers = screen.getAllByRole('button', { name: 'Von Hand zuordnen' });
    expect(openers.length).toBe(40);
    await user.click(openers[3]);
    expect(container.querySelectorAll('option[value^="r-"]').length).toBe(30);
    expect(openers[3].getAttribute('aria-expanded')).toBe('true');
    await user.click(openers[7]);
    expect(container.querySelectorAll('option[value^="r-"]').length).toBe(30);
    expect(openers[3].getAttribute('aria-expanded')).toBe('false');
    await user.click(openers[7]);
    expect(container.querySelectorAll('option[value^="r-"]').length).toBe(0);
  });

  it('without anything to link to, no picker is offered', () => {
    render(<PaymentsTab view={view({ open: [open()] })} {...props()} />);
    expect(screen.queryByRole('button', { name: 'Von Hand zuordnen' })).toBeNull();
  });

  it('offers a payment for a receipt on an estimated amount; one click takes one, one click takes all unambiguous ones', async () => {
    const user = userEvent.setup();
    const p = props();
    const proposal = { paymentId: 'p-1', rowId: 'r-1', receiptLabel: 'Editor Beispiel März', receiptDay: '2026-03-02', estimateCents: 2_000, bookingDay: '2026-03-03', paidCents: 2_075, counterparty: 'Editor Beispiel', accountLabel: 'Später zahlen', unambiguous: true };
    const estimateProposals = [proposal, { ...proposal, paymentId: 'p-2', rowId: 'r-2', receiptLabel: 'Editor Beispiel April', receiptDay: '2026-04-02', bookingDay: '2026-04-03' }, { ...proposal, paymentId: 'p-3', rowId: 'r-3', receiptLabel: 'Hosting Beispiel', unambiguous: false }];
    render(<PaymentsTab view={view({ estimateProposals })} {...p} />);
    const section = screen.getByRole('region', { name: 'Vorschläge für geschätzte Belege' });
    const first = within(section).getByText(/Editor Beispiel März/).closest('li') as HTMLElement;
    expect(first.textContent).toContain('geschätzt 20,00 € · bezahlt 20,75 € am 03.03.2026 an Editor Beispiel · Später zahlen');
    expect((within(section).getByText(/Hosting Beispiel/).closest('li') as HTMLElement).textContent).toContain('mehrdeutig, bitte einzeln prüfen');

    // Nothing is linked by drawing the list.
    expect(p.onLink).not.toHaveBeenCalled();
    await user.click(within(first).getByRole('button', { name: 'Übernehmen' }));
    expect(p.onLink).toHaveBeenCalledWith({ paymentId: 'p-1', rowId: 'r-1' });

    // The bulk action counts the unambiguous ones only, asks first, and sends no list: the server works it out again.
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    await user.click(within(section).getByRole('button', { name: 'Alle 2 eindeutigen Vorschläge übernehmen' }));
    expect(p.onAcceptProposals).not.toHaveBeenCalled();
    await user.click(within(section).getByRole('button', { name: 'Alle 2 eindeutigen Vorschläge übernehmen' }));
    expect(p.onAcceptProposals).toHaveBeenCalledWith();
    expect(confirm.mock.calls[0][0]).toContain('2 eindeutige Vorschläge übernehmen?');
    confirm.mockRestore();
  });

  it('only ambiguous proposals: each can be taken, there is nothing to take in bulk; no proposals, no section', () => {
    const proposal = { paymentId: 'p-1', rowId: 'r-1', receiptLabel: 'Editor Beispiel', receiptDay: '2026-03-02', estimateCents: 2_000, bookingDay: '2026-03-03', paidCents: 2_075, counterparty: '', accountLabel: 'Später zahlen', unambiguous: false };
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
          links: [{ linkId: 'l-2', paymentId: 'p-1', bookingDay: '2026-03-03', cents: 2_075, counterparty: 'Editor Beispiel', target: 'receipt', targetLabel: 'Editor Beispiel März', method: 'estimate' }],
        })}
        {...props()}
      />,
    );
    expect(screen.getByText(/12 Umbuchungen zwischen eigenen Konten, nach denen nicht gefragt wird/)).toBeTruthy();
    expect(screen.getByText('Vorschlag, von dir übernommen')).toBeTruthy();
  });

  it('reports the rows a pay-later list left out in plain words', () => {
    render(
      <PaymentsTab
        view={view()}
        {...props()}
        lastImport={{ batchId: 'b', format: 'klarna_csv', total: 5, added: 5, alreadyThere: 0, skipped: { cancelled: 2, duplicate_row: 1, zero_amount: 1 }, autoLinked: 0, firstDay: null, lastDay: null }}
      />,
    );
    expect(screen.getByRole('status').textContent).toContain('2 storniert oder vollständig erstattet, 1 doppelt in der Datei, 1 ohne Betrag');
  });

  it('a refund asks for the receipt it belongs to', () => {
    render(<PaymentsTab view={view({ open: [open({ amountCents: 750, freeCents: 750, kind: 'refund', check: 'refund_without_receipt' })] })} {...props()} />);
    expect(screen.getByText(/Erstattung: dem Beleg zuordnen/)).toBeTruthy();
  });
});
