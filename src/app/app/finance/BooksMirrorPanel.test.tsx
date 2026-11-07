// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { setupUser } from '../../../../test/user';
import type { BooksMirrorView } from '@/lib/tax/books-pull/service';
import BooksMirrorPanel from './BooksMirrorPanel';

afterEach(() => cleanup());

const report = { created: 2, attached: 1, updated: 0, unchanged: 60, paymentsMoved: 0, skipped: [{ number: '23', reason: 'not_euro' as const }], conflicts: [] };
const landed = (o: Partial<NonNullable<BooksMirrorView['last']>> = {}): BooksMirrorView => ({
  configured: true,
  last: { at: '2026-11-08T05:15:00.000Z', trigger: 'schedule', ok: true, error: null, successAt: '2026-11-08T05:15:00.000Z', report, ...o },
});

describe('BooksMirrorPanel', () => {
  it('shows what the last pull brought and pulls on the button', async () => {
    const onPull = vi.fn();
    render(<BooksMirrorPanel mirror={landed()} busy={false} onPull={onPull} />);
    expect(screen.getByText(/Zuletzt automatisch abgeholt am/)).toBeTruthy();
    expect(screen.getByText(/2 neu, 1 einer hier erfassten Rechnung zugeordnet/)).toBeTruthy();
    expect(screen.getByText(/1 Dokument bewusst nicht übernommen/)).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    await setupUser().click(screen.getByRole('button', { name: 'Aus den Books abholen' }));
    expect(onPull).toHaveBeenCalledTimes(1);
  });

  it('names every document that needs a decision, by its number', () => {
    render(<BooksMirrorPanel mirror={landed({ report: { ...report, conflicts: [{ number: '58', reason: 'register_differs' }] } })} busy={false} onPull={() => undefined} />);
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toMatch(/Rechnung 58: Betrag, Steuer oder Datum weichen/);
  });

  it('shows a failed pull as a failure, with the last one that worked', () => {
    render(
      <BooksMirrorPanel
        mirror={landed({ at: '2026-11-08T06:15:00.000Z', ok: false, error: 'books_key_refused', successAt: '2026-11-08T05:15:00.000Z' })}
        busy={false}
        onPull={() => undefined}
      />,
    );
    expect(screen.getByText(/ohne Erfolg/)).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toMatch(/Schlüssel dieser App abgelehnt.*Zuletzt gelungen am/);
  });

  it('says when the server holds no key, and offers no button that cannot work', () => {
    render(<BooksMirrorPanel mirror={{ configured: false, last: null }} busy={false} onPull={() => undefined} />);
    expect(screen.getByText(/nicht eingerichtet/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Aus den Books abholen' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('says when nothing was pulled yet, and waits while reading', () => {
    const { rerender } = render(<BooksMirrorPanel mirror={null} busy={false} onPull={() => undefined} />);
    expect(screen.getByText(/Stand wird gelesen/)).toBeTruthy();
    rerender(<BooksMirrorPanel mirror={{ configured: true, last: null }} busy={false} onPull={() => undefined} />);
    expect(screen.getByText(/Noch nicht aus den Books abgeholt/)).toBeTruthy();
  });
});
