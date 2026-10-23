// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { StatementView, YearBoundaryEntry } from '@/lib/tax/service';
import YearBoundaryTab from './YearBoundaryTab';

afterEach(cleanup);

/** An open entry: nobody and no rule answered it. Every name and amount is invented. */
const entry = (o: Partial<YearBoundaryEntry> = {}): YearBoundaryEntry => ({
  kind: 'receipt',
  subjectId: 'r-1',
  label: 'Vermieter Beispiel',
  cashDay: '2025-12-29',
  dayBasis: 'payment',
  cents: 65_000,
  otherYear: 2026,
  answer: null,
  source: null,
  reason: 'Ohne Lieferant lässt sich nicht erkennen, ob die Zahlung regelmäßig wiederkehrt',
  storedAnswer: null,
  filedYear: null,
  departsFromFiled: null,
  inactive: null,
  ...o,
});
const byRule = (o: Partial<YearBoundaryEntry> = {}) => entry({ answer: false, source: 'rule', reason: 'Abo, Zeitraum beginnt am Zahltag', ...o });
const view = (yearBoundary: YearBoundaryEntry[]): StatementView => ({ year: 2025, yearBoundary }) as StatementView;
const props = () => ({ busy: false, error: null, onAnswer: vi.fn(), onDeclineOpen: vi.fn() });

describe('YearBoundaryTab', () => {
  it('explains the rule with its source and says when there is nothing to answer', () => {
    render(<YearBoundaryTab view={view([])} {...props()} />);
    expect(screen.getByText(/§ 11 Absatz 1 Satz 2 und Absatz 2 Satz 2/)).toBeTruthy();
    expect(screen.getByText(/Gefragt wird nur, was keine Regel klärt/)).toBeTruthy();
    expect(screen.getByText(/keine Zahlung zwischen dem 22. Dezember und dem 10. Januar/)).toBeTruthy();
  });

  it('an open payment says where it counts until then and why it is asked, and each answer is one click', async () => {
    const user = userEvent.setup();
    const p = props();
    const e = entry();
    render(<YearBoundaryTab view={view([e])} {...p} />);
    expect(screen.getByRole('status').textContent).toBe('Noch offen: zählt bis dahin für 2025. Ohne Lieferant lässt sich nicht erkennen, ob die Zahlung regelmäßig wiederkehrt.');
    expect(screen.queryByRole('button', { name: 'Antwort zurücknehmen' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Regelmäßig wiederkehrend, gehört zu 2026' }));
    expect(p.onAnswer).toHaveBeenCalledWith(e, true);
    await user.click(screen.getByRole('button', { name: 'Bleibt in 2025' }));
    expect(p.onAnswer).toHaveBeenCalledWith(e, false);
  });

  it('a payment a rule answers shows the rule as its reason, presses no button, and can still be overridden', async () => {
    const user = userEvent.setup();
    const p = props();
    const e = byRule();
    render(<YearBoundaryTab view={view([e, byRule({ subjectId: 'r-2', reason: 'einmalige Zahlung' })])} {...p} />);
    const [first, second] = screen.getAllByRole('listitem');
    expect(within(first).getByRole('status').textContent).toBe('Bleibt in 2025. Grund: Abo, Zeitraum beginnt am Zahltag.');
    expect(within(second).getByRole('status').textContent).toBe('Bleibt in 2025. Grund: einmalige Zahlung.');
    // Nobody answered: no button is pressed and there is nothing to take back.
    expect(within(first).getByRole('button', { name: 'Bleibt in 2025' }).getAttribute('aria-pressed')).toBe('false');
    expect(within(first).queryByRole('button', { name: 'Antwort zurücknehmen' })).toBeNull();
    // Both are answered by a rule: nothing is open, "none of these" is not offered.
    expect(screen.queryByRole('button', { name: 'Keine davon ist regelmäßig wiederkehrend' })).toBeNull();
    await user.click(within(first).getByRole('button', { name: 'Regelmäßig wiederkehrend, gehört zu 2026' }));
    expect(p.onAnswer).toHaveBeenCalledWith(e, true);
  });

  it('a January payment is offered the year before; a person\'s answer shows as pressed and can be taken back', async () => {
    const user = userEvent.setup();
    const p = props();
    const e = entry({ kind: 'vat_settlement', subjectId: 's-1', label: 'Umsatzsteuer: Zahlung an das Finanzamt', cashDay: '2026-01-08', otherYear: 2025, answer: true, storedAnswer: true, source: 'person', reason: 'Antwort von Hand' });
    render(<YearBoundaryTab view={view([e])} {...p} />);
    expect(screen.getByRole('status').textContent).toBe('Zählt für 2025. Antwort von Hand.');
    expect(screen.getByRole('button', { name: 'Regelmäßig wiederkehrend, gehört zu 2025' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Bleibt in 2026' }).getAttribute('aria-pressed')).toBe('false');
    await user.click(screen.getByRole('button', { name: 'Antwort zurücknehmen' }));
    expect(p.onAnswer).toHaveBeenCalledWith(e, null);
  });

  it('a payment of a filed year is fixed: no answer is offered, and an answer that departs from the return is shown and can be taken back', async () => {
    const user = userEvent.setup();
    const p = props();
    const fixed = entry({ answer: false, source: 'filed', filedYear: 2025, reason: 'Festgelegt durch die abgegebene Erklärung 2025' });
    const departs = entry({ subjectId: 'r-2', answer: false, source: 'filed', filedYear: 2025, storedAnswer: true, departsFromFiled: 2025, reason: 'Weicht von der abgegebenen Erklärung 2025 ab' });
    const filedWithIt = entry({ subjectId: 'r-3', answer: true, source: 'person', filedYear: 2025, storedAnswer: true, reason: 'Antwort von Hand, vor der Abgabe der Erklärung 2025 gegeben und so erklärt' });
    render(<YearBoundaryTab view={view([fixed, departs, filedWithIt])} {...p} />);
    const [first, second, third] = screen.getAllByRole('listitem');
    expect(within(first).getByRole('status').textContent).toBe('Bleibt in 2025. Grund: Festgelegt durch die abgegebene Erklärung 2025.');
    expect(within(first).queryAllByRole('button')).toEqual([]);
    expect(within(second).getByRole('status').textContent).toContain('Weicht von der abgegebenen Erklärung 2025 ab');
    expect(within(second).getByRole('status').textContent).toContain('wird nicht angewendet');
    expect(within(second).queryByRole('button', { name: /Regelmäßig wiederkehrend/ })).toBeNull();
    await user.click(within(second).getByRole('button', { name: 'Antwort zurücknehmen' }));
    expect(p.onAnswer).toHaveBeenCalledWith(departs, null);
    // An answer that went into the return is part of it: it stays, and cannot be taken back here.
    expect(within(third).getByRole('status').textContent).toBe('Zählt für 2026. Antwort von Hand, vor der Abgabe der Erklärung 2025 gegeben und so erklärt.');
    expect(within(third).queryAllByRole('button')).toEqual([]);
  });

  it('"none of these" is offered only when more than one payment is open, and a receipt without a payment says so', async () => {
    const user = userEvent.setup();
    const p = props();
    const { rerender } = render(<YearBoundaryTab view={view([entry(), entry({ subjectId: 'r-2', answer: false, storedAnswer: false, source: 'person', reason: 'Antwort von Hand' })])} {...p} />);
    expect(screen.queryByRole('button', { name: 'Keine davon ist regelmäßig wiederkehrend' })).toBeNull();
    rerender(<YearBoundaryTab view={view([entry(), entry({ subjectId: 'r-2', dayBasis: 'document', cents: null })])} {...p} />);
    const second = screen.getAllByRole('listitem')[1];
    expect(within(second).getByText(/Belegdatum \(keine Zahlung zugeordnet\)/)).toBeTruthy();
    expect(second.textContent).toContain('ohne Betrag');
    expect(screen.getByText('2 Zahlungen ohne Antwort')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Keine davon ist regelmäßig wiederkehrend' }));
    expect(p.onDeclineOpen).toHaveBeenCalled();
  });

  it('an answer without effect (the receipt became an asset) says so and can only be taken back', async () => {
    const user = userEvent.setup();
    const p = props();
    const e = entry({ answer: true, storedAnswer: true, source: 'person', reason: 'Antwort von Hand', inactive: 'asset' });
    render(<YearBoundaryTab view={view([e, entry({ subjectId: 'r-2' })])} {...p} />);
    const first = screen.getAllByRole('listitem')[0];
    expect(within(first).getByRole('status').textContent).toContain('wird nicht angewendet');
    expect(within(first).queryByRole('button', { name: /Regelmäßig wiederkehrend/ })).toBeNull();
    // One payment is open, so "none of these" is not offered; the entry without effect does not count as open.
    expect(screen.queryByRole('button', { name: 'Keine davon ist regelmäßig wiederkehrend' })).toBeNull();
    await user.click(within(first).getByRole('button', { name: 'Antwort zurücknehmen' }));
    expect(p.onAnswer).toHaveBeenCalledWith(e, null);
  });

  it('a failed save is shown', () => {
    render(<YearBoundaryTab view={view([entry()])} {...props()} error="Speichern fehlgeschlagen." />);
    expect(screen.getByRole('alert').textContent).toContain('Speichern fehlgeschlagen');
  });
});
