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
    payments: { accounts: [account], yearCount: 3, linkedCount: 1, unclassified: [], treatments: [], open: [], overridden: [], receiptTargets: [], invoiceTargets: [], links: [], ...payments },
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

  it('a refund asks for the receipt it belongs to', () => {
    render(<PaymentsTab view={view({ open: [open({ amountCents: 750, freeCents: 750, kind: 'refund', check: 'refund_without_receipt' })] })} {...props()} />);
    expect(screen.getByText(/Erstattung: dem Beleg zuordnen/)).toBeTruthy();
  });
});
