// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SMALL_BUSINESS, UNANSWERED, meal } from '@/lib/meals/__tests__/fixtures';
import ConfirmDialog from '@/components/ui/ConfirmDialog';

const saveMealTaxSettings = vi.fn();
vi.mock('./actions', () => ({ saveMealTaxSettings: (...a: unknown[]) => saveMealTaxSettings(...a) }));

import RegisterTab from './RegisterTab';

const fetchMock = vi.fn();
const records = [
  meal({ rowId: 'a' }),
  meal({ rowId: 'b', date: '2025-08-01', guests: [] }),
  meal({ rowId: 'c', date: '2025-09-01', mealType: 'travel_meal', gross: 20 }),
];

beforeEach(() => {
  fetchMock.mockReset();
  saveMealTaxSettings.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  URL.createObjectURL = vi.fn(() => 'blob:test');
  URL.revokeObjectURL = vi.fn();
  // jsdom does not implement navigation; a download click must not throw.
  HTMLAnchorElement.prototype.click = vi.fn();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function file(headers: Record<string, string> = {}) {
  return new Response('x', { status: 200, headers });
}

describe('RegisterTab: section 19 question', () => {
  it('unanswered: asks the question, lists the entry without amounts, locks both exports', async () => {
    const onSettingsChanged = vi.fn();
    render(<RegisterTab records={records} settings={UNANSWERED} onSettingsChanged={onSettingsChanged} onOpenQueue={vi.fn()} />);
    expect(screen.getByRole('heading', { name: /Kleinunternehmer nach § 19/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Als CSV exportieren' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Als PDF exportieren' })).toHaveProperty('disabled', true);
    const table = screen.getByRole('table');
    expect(within(table).getByText('Testlokal, Musterstraße 1, 12345 Musterstadt')).toBeTruthy();
    expect(within(table).queryByText(/€/)).toBeNull();
    expect(within(table).queryByText('Summe')).toBeNull();

    saveMealTaxSettings.mockResolvedValue({ ok: true, value: SMALL_BUSINESS });
    await userEvent.setup().click(screen.getByRole('button', { name: 'Ja, Kleinunternehmer' }));
    expect(saveMealTaxSettings).toHaveBeenCalledWith({ smallBusiness: true });
    expect(onSettingsChanged).toHaveBeenCalledWith(SMALL_BUSINESS);
  });

  it('a failed answer is shown and nothing changes', async () => {
    const onSettingsChanged = vi.fn();
    render(<RegisterTab records={records} settings={UNANSWERED} onSettingsChanged={onSettingsChanged} onOpenQueue={vi.fn()} />);
    saveMealTaxSettings.mockResolvedValue({ ok: false, error: 'forbidden' });
    await userEvent.setup().click(screen.getByRole('button', { name: 'Nein, mit Vorsteuerabzug' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/Berechtigung/);
    expect(onSettingsChanged).not.toHaveBeenCalled();
  });

  it('answered: shows totals, the incomplete block and the separate count', () => {
    render(<RegisterTab records={records} settings={SMALL_BUSINESS} onSettingsChanged={vi.fn()} onOpenQueue={vi.fn()} />);
    expect(screen.queryByRole('heading', { name: /Kleinunternehmer nach § 19/ })).toBeNull();
    const table = screen.getByRole('table');
    expect(within(table).getByText('Summe')).toBeTruthy();
    expect(within(table).getAllByText(/91,00/).length).toBeGreaterThan(0);
    expect(screen.getByText(/1 Bewirtung aus 2025 ist unvollständig und zählt nicht mit/)).toBeTruthy();
    expect(screen.getByText(/Verpflegung auf Reise: 1/)).toBeTruthy();
  });
});

describe('RegisterTab: export', () => {
  function mount() {
    render(<RegisterTab records={records} settings={SMALL_BUSINESS} onSettingsChanged={vi.fn()} onOpenQueue={vi.fn()} />);
    return userEvent.setup();
  }

  it('with incomplete entries: confirms with the count the server reports, then exports acknowledging exactly it', async () => {
    const user = mount();
    fetchMock
      .mockResolvedValueOnce(Response.json({ error: 'incomplete_unacknowledged', incompleteCount: 1 }, { status: 409 }))
      .mockResolvedValueOnce(file());
    await user.click(screen.getByRole('button', { name: 'Als CSV exportieren' }));

    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toMatch(/1 Bewirtung aus 2025 ist unvollständig/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe('/api/meals/register?year=2025&format=csv');

    await user.click(within(dialog).getByRole('button', { name: 'Trotzdem exportieren' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(String(fetchMock.mock.calls[1][0])).toBe('/api/meals/register?year=2025&format=csv&ack=1');
    await waitFor(() => expect(HTMLAnchorElement.prototype.click).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('cancelling the confirmation exports nothing', async () => {
    const user = mount();
    fetchMock.mockResolvedValueOnce(Response.json({ error: 'incomplete_unacknowledged', incompleteCount: 1 }, { status: 409 }));
    await user.click(screen.getByRole('button', { name: 'Als PDF exportieren' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Zurück' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(HTMLAnchorElement.prototype.click).not.toHaveBeenCalled();
  });

  it('shows the warnings the PDF export reports (for example a receipt that could not be embedded)', async () => {
    const user = mount();
    fetchMock.mockResolvedValueOnce(
      file({ 'X-Register-Warnings': encodeURIComponent(JSON.stringify(['Nr. 1: Es ist kein Beleg hinterlegt.'])) }),
    );
    await user.click(screen.getByRole('button', { name: 'Als PDF exportieren' }));
    expect(await screen.findByText('Nr. 1: Es ist kein Beleg hinterlegt.')).toBeTruthy();
  });

  it('a server error and a dead connection each produce a visible message, never a silent nothing', async () => {
    const user = mount();
    fetchMock.mockResolvedValueOnce(Response.json({ error: 'export_failed' }, { status: 500 }));
    await user.click(screen.getByRole('button', { name: 'Als CSV exportieren' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/fehlgeschlagen/);
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await user.click(screen.getByRole('button', { name: 'Als CSV exportieren' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/keine Verbindung/));
    expect(HTMLAnchorElement.prototype.click).not.toHaveBeenCalled();
  });

  it('an expired session says so', async () => {
    const user = mount();
    fetchMock.mockResolvedValueOnce(Response.json({ error: 'unauthorized' }, { status: 401 }));
    await user.click(screen.getByRole('button', { name: 'Als CSV exportieren' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/Anmeldung ist abgelaufen/);
  });
});

describe('ConfirmDialog', () => {
  it('is modal, focuses the safe choice, closes on Escape and returns focus', async () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    const user = userEvent.setup();
    function Harness({ open }: { open: boolean }) {
      return (
        <>
          <button>Auslöser</button>
          <ConfirmDialog open={open} title="Wirklich?" confirmLabel="Ja" onCancel={onCancel} onConfirm={onConfirm}>
            Text
          </ConfirmDialog>
        </>
      );
    }
    const { rerender } = render(<Harness open={false} />);
    const trigger = screen.getByRole('button', { name: 'Auslöser' });
    trigger.focus();
    rerender(<Harness open />);
    const dialog = screen.getByRole('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Abbrechen' }));
    // Focus stays inside the dialog.
    await user.tab();
    await user.tab();
    expect(dialog.contains(document.activeElement)).toBe(true);
    await user.keyboard('{Escape}');
    expect(onCancel).toHaveBeenCalledTimes(1);
    await user.click(within(dialog).getByRole('button', { name: 'Ja' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    rerender(<Harness open={false} />);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
