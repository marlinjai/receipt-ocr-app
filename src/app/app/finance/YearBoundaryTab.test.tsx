// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { StatementView, YearBoundaryEntry } from '@/lib/tax/service';
import YearBoundaryTab from './YearBoundaryTab';

afterEach(cleanup);

const entry = (o: Partial<YearBoundaryEntry> = {}): YearBoundaryEntry => ({ kind: 'receipt', subjectId: 'r-1', label: 'Vermieter Beispiel', cashDay: '2025-12-29', dayBasis: 'payment', cents: 65_000, otherYear: 2026, answer: null, ...o });
const view = (yearBoundary: YearBoundaryEntry[]): StatementView => ({ year: 2025, yearBoundary }) as StatementView;
const props = () => ({ busy: false, error: null, onAnswer: vi.fn(), onDeclineOpen: vi.fn() });

describe('YearBoundaryTab', () => {
  it('explains the rule with its source and says when there is nothing to answer', () => {
    render(<YearBoundaryTab view={view([])} {...props()} />);
    expect(screen.getByText(/§ 11 Absatz 1 Satz 2 und Absatz 2 Satz 2/)).toBeTruthy();
    expect(screen.getByText(/keine Zahlung zwischen dem 22. Dezember und dem 10. Januar/)).toBeTruthy();
  });

  it('an unanswered payment says where it counts until then, and each answer is one click', async () => {
    const user = userEvent.setup();
    const p = props();
    const e = entry();
    render(<YearBoundaryTab view={view([e])} {...p} />);
    expect(screen.getByRole('status').textContent).toContain('zählt bis dahin für 2025');
    expect(screen.queryByRole('button', { name: 'Antwort zurücknehmen' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Regelmäßig wiederkehrend, gehört zu 2026' }));
    expect(p.onAnswer).toHaveBeenCalledWith(e, true);
    await user.click(screen.getByRole('button', { name: 'Bleibt in 2025' }));
    expect(p.onAnswer).toHaveBeenCalledWith(e, false);
  });

  it('a January payment is offered the year before; an answer shows as pressed and can be taken back', async () => {
    const user = userEvent.setup();
    const p = props();
    const e = entry({ kind: 'vat_settlement', subjectId: 's-1', label: 'Umsatzsteuer: Zahlung an das Finanzamt', cashDay: '2026-01-08', otherYear: 2025, answer: true });
    render(<YearBoundaryTab view={view([e])} {...p} />);
    expect(screen.getByRole('status').textContent).toContain('Zählt für 2025');
    expect(screen.getByRole('button', { name: 'Regelmäßig wiederkehrend, gehört zu 2025' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Bleibt in 2026' }).getAttribute('aria-pressed')).toBe('false');
    await user.click(screen.getByRole('button', { name: 'Antwort zurücknehmen' }));
    expect(p.onAnswer).toHaveBeenCalledWith(e, null);
  });

  it('"none of these" is offered only when more than one payment is open, and a receipt without a payment says so', async () => {
    const user = userEvent.setup();
    const p = props();
    const { rerender } = render(<YearBoundaryTab view={view([entry(), entry({ subjectId: 'r-2', answer: false })])} {...p} />);
    expect(screen.queryByRole('button', { name: 'Keine davon ist regelmäßig wiederkehrend' })).toBeNull();
    rerender(<YearBoundaryTab view={view([entry(), entry({ subjectId: 'r-2', dayBasis: 'document', cents: null })])} {...p} />);
    const second = screen.getAllByRole('listitem')[1];
    expect(within(second).getByText(/Belegdatum \(keine Zahlung zugeordnet\)/)).toBeTruthy();
    expect(second.textContent).toContain('ohne Betrag');
    await user.click(screen.getByRole('button', { name: 'Keine davon ist regelmäßig wiederkehrend' }));
    expect(p.onDeclineOpen).toHaveBeenCalled();
  });

  it('a failed save is shown', () => {
    render(<YearBoundaryTab view={view([entry()])} {...props()} error="Speichern fehlgeschlagen." />);
    expect(screen.getByRole('alert').textContent).toContain('Speichern fehlgeschlagen');
  });
});
