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

function bar(rows: Set<string>, setField: (ids: string[], columnId: string, value: string | null) => Promise<BulkSetOutcome>) {
  const onDone = vi.fn(async () => undefined);
  render(
    <BulkEditBar columns={[column]} selectOptions={options} loadSelectOptions={vi.fn(async () => undefined)} selectedRows={rows} setField={setField} onDone={onDone} />,
  );
  return { onDone };
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
    const { onDone } = bar(selection(230), setField);
    const user = await choose('biz');
    await user.click(screen.getByRole('button', { name: 'Apply to 230' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('230 von 230 gesetzt.'));
    expect(setField.mock.calls.map(([ids]) => ids.length)).toEqual([BULK_SET_PART, BULK_SET_PART, 30]);
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
    await user.click(screen.getByRole('button', { name: 'Erneut versuchen (1)' }));
    expect(setField).toHaveBeenLastCalledWith(['r0'], 'zuordnung', 'biz');
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('1 von 1 gesetzt.'));
  });

  it('counts a part that got no answer as not set, and the other parts as they came', async () => {
    const setField = vi.fn(async (ids: string[]): Promise<BulkSetOutcome> => {
      if (ids[0] === 'r0') throw new Error('network');
      return { done: ids, failed: [] };
    });
    bar(selection(150), setField);
    const user = await choose('priv');
    await user.click(screen.getByRole('button', { name: 'Apply to 150' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('50 von 150 gesetzt. 100 nicht gesetzt: 100 keine Antwort, Stand unklar.'));
    expect(screen.getByRole('button', { name: 'Erneut versuchen (100)' })).toBeTruthy();
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
    await waitFor(() => expect(screen.getByRole('button', { name: 'Erneut versuchen (3)' })).toBeTruthy());
    await user.selectOptions(screen.getByLabelText('Bulk edit value'), 'priv');
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryByRole('button', { name: /Erneut versuchen/ })).toBeNull();
  });
});
