// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Column, SelectOption } from '@marlinjai/data-table-core';
import BulkEditBar from './BulkEditBar';
import { BULK_SET_PART, type BulkSetOutcome } from './bulk-set';

afterEach(cleanup);

const column = { id: 'zuordnung', tableId: 't', name: 'Zuordnung', type: 'select', position: 0, width: 100, isPrimary: false, config: {}, createdAt: new Date(0) } as Column;
const options = new Map<string, SelectOption[]>([
  [
    'zuordnung',
    [
      { id: 'biz', columnId: 'zuordnung', name: 'Geschäftlich', position: 0 },
      { id: 'priv', columnId: 'zuordnung', name: 'Privat', position: 1 },
    ],
  ],
]);
const selection = (n: number) => new Set(Array.from({ length: n }, (_, i) => `r${i}`));

type SetField = (ids: string[], columnId: string, value: string | null) => Promise<BulkSetOutcome>;

function bar(rows: Set<string>, setField: SetField, onDone: () => Promise<void> = vi.fn(async () => undefined)) {
  const view = (selected: Set<string>) => (
    <BulkEditBar columns={[column]} selectOptions={options} loadSelectOptions={vi.fn(async () => undefined)} selectedRows={selected} setField={setField} onDone={onDone} />
  );
  const { rerender } = render(view(rows));
  return { onDone, select: (selected: Set<string>) => rerender(view(selected)) };
}

async function choose(value: string) {
  const user = userEvent.setup();
  await user.selectOptions(screen.getByLabelText('Bulk edit column'), 'zuordnung');
  await user.selectOptions(screen.getByLabelText('Bulk edit value'), value);
  return user;
}

describe('"Set field" on a selection', () => {
  it('sends a large selection in parts and says how many were really set', async () => {
    const setField = vi.fn(async (ids: string[]) => ({ done: ids, failed: [] }));
    const { onDone } = bar(selection(2 * BULK_SET_PART + 5), setField);
    const user = await choose('biz');
    await user.click(screen.getByRole('button', { name: `Apply to ${2 * BULK_SET_PART + 5}` }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe(`${2 * BULK_SET_PART + 5} von ${2 * BULK_SET_PART + 5} gesetzt.`));
    expect(setField.mock.calls.map(([ids]) => ids.length)).toEqual([BULK_SET_PART, BULK_SET_PART, 5]);
    expect(setField.mock.calls.every(([, columnId, value]) => columnId === 'zuordnung' && value === 'biz')).toBe(true);
    // The table is loaded again, so it shows what is stored.
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: /Erneut versuchen/ })).toBeNull();
  });

  it('never counts a row whose write did not land, and offers another try for it', async () => {
    let attempt = 0;
    const setField = vi.fn(async (ids: string[]): Promise<BulkSetOutcome> => {
      attempt++;
      if (attempt === 1) {
        return {
          done: ids.slice(2),
          failed: [
            { rowId: ids[0], reason: 'not_stored' },
            { rowId: ids[1], reason: 'not_found' },
          ],
        };
      }
      return { done: ids, failed: [] };
    });
    bar(selection(30), setField);
    const user = await choose('biz');
    await user.click(screen.getByRole('button', { name: 'Apply to 30' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('28 von 30 gesetzt. 2 nicht gesetzt: 1 nicht gespeichert, 1 nicht gefunden.'));
    // Only the row that may still work is tried again; the deleted one would fail again.
    await user.click(screen.getByRole('button', { name: 'Erneut versuchen für die 1 nicht gesetzten' }));
    expect(setField).toHaveBeenLastCalledWith(['r0'], 'zuordnung', 'biz');
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('1 von 1 gesetzt.'));
  });

  it('counts a part that got no answer as not set, and the other parts as they came', async () => {
    const setField = vi.fn(async (ids: string[]): Promise<BulkSetOutcome> => {
      if (ids[0] === 'r0') throw new Error('network');
      return { done: ids, failed: [] };
    });
    bar(selection(BULK_SET_PART + 10), setField);
    const user = await choose('priv');
    await user.click(screen.getByRole('button', { name: `Apply to ${BULK_SET_PART + 10}` }));
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toBe(
        `10 von ${BULK_SET_PART + 10} gesetzt. ${BULK_SET_PART} nicht gesetzt: ${BULK_SET_PART} keine Antwort, Stand unklar.`,
      ),
    );
    expect(screen.getByRole('button', { name: `Erneut versuchen für die ${BULK_SET_PART} nicht gesetzten` })).toBeTruthy();
  });

  it('a retry on which nothing answers again asks for a new page load instead of a further retry', async () => {
    const setField = vi.fn(async (): Promise<BulkSetOutcome> => {
      throw new Error('session expired');
    });
    bar(selection(3), setField);
    const user = await choose('biz');
    await user.click(screen.getByRole('button', { name: 'Apply to 3' }));
    await user.click(await screen.findByRole('button', { name: 'Erneut versuchen für die 3 nicht gesetzten' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Bitte die Seite neu laden'));
    expect(screen.queryByRole('button', { name: /Erneut versuchen/ })).toBeNull();
  });

  it('keeps the outcome in view when the reload afterwards empties the selection', async () => {
    const setField = vi.fn(async (ids: string[]): Promise<BulkSetOutcome> => ({ done: ids.slice(1), failed: [{ rowId: ids[0], reason: 'not_stored' }] }));
    let view: ReturnType<typeof bar> | undefined;
    // The view filters on the column just set: after the reload none of the rows is shown or selected.
    const onDone = vi.fn(async () => view!.select(new Set()));
    view = bar(selection(4), setField, onDone);
    const user = await choose('biz');
    await user.click(screen.getByRole('button', { name: 'Apply to 4' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('3 von 4 gesetzt. 1 nicht gesetzt: 1 nicht gespeichert.'));
    expect(screen.getByRole('button', { name: 'Erneut versuchen für die 1 nicht gesetzten' })).toBeTruthy();
  });

  it('says so when the table cannot be loaded again afterwards', async () => {
    const setField = vi.fn(async (ids: string[]) => ({ done: ids, failed: [] }));
    bar(selection(2), setField, vi.fn(async () => Promise.reject(new Error('offline'))));
    const user = await choose('biz');
    await user.click(screen.getByRole('button', { name: 'Apply to 2' }));
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toBe('2 von 2 gesetzt. Die Tabelle konnte nicht neu geladen werden, bitte die Seite neu laden.'),
    );
  });

  it('clears the field with the empty choice', async () => {
    const setField = vi.fn(async (ids: string[]) => ({ done: ids, failed: [] }));
    bar(selection(2), setField);
    const user = await choose('__clear__');
    await user.click(screen.getByRole('button', { name: 'Apply to 2' }));
    await waitFor(() => expect(setField).toHaveBeenCalledWith(['r0', 'r1'], 'zuordnung', null));
  });

  it('a changed value forgets the outcome and the retry of the earlier one', async () => {
    const setField = vi.fn(async (ids: string[]): Promise<BulkSetOutcome> => ({ done: [], failed: ids.map((rowId) => ({ rowId, reason: 'failed' as const })) }));
    bar(selection(3), setField);
    const user = await choose('biz');
    await user.click(screen.getByRole('button', { name: 'Apply to 3' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Erneut versuchen für die 3 nicht gesetzten' })).toBeTruthy());
    await user.selectOptions(screen.getByLabelText('Bulk edit value'), 'priv');
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryByRole('button', { name: /Erneut versuchen/ })).toBeNull();
  });
});
