// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ReceiptDetailPanel from '../ReceiptDetailPanel';

vi.mock('@/lib/meals/pdf-render', () => ({ renderPdfPage: vi.fn(() => new Promise(() => {})) }));

afterEach(cleanup);

const ASSIGNMENT_COL = 'col-assignment';
const column = { id: ASSIGNMENT_COL, tableId: 't-1', name: 'Zuordnung', type: 'select', position: 0, width: 100, isPrimary: false, config: {}, createdAt: new Date() };
const options = new Map([[ASSIGNMENT_COL, [
  { id: 'opt-business', columnId: ASSIGNMENT_COL, name: 'Geschäftlich', position: 0 },
  { id: 'opt-private', columnId: ASSIGNMENT_COL, name: 'Privat', position: 1 },
]]]);

type NoteLoader = (rowId: string) => Promise<{ assignment: string | null; reason: string | null } | null>;

function renderPanel(value: string | null, onSetAssignment?: (rowId: string, optionId: string | null) => Promise<boolean>, loadAssignmentNote?: NoteLoader) {
  const row = { id: 'row-1', tableId: 't-1', cells: { [ASSIGNMENT_COL]: value }, createdAt: new Date(), updatedAt: new Date() };
  render(<ReceiptDetailPanel row={row as never} columns={[column] as never} selectOptions={options as never} onClose={vi.fn()} onSetAssignment={onSetAssignment} loadAssignmentNote={loadAssignmentNote} />);
}

const field = () => screen.getByRole('combobox', { name: 'Zuordnung' }) as HTMLSelectElement;

describe('ReceiptDetailPanel Zuordnung', () => {
  it('sets a missing Zuordnung and shows the stored one', async () => {
    const save = vi.fn().mockResolvedValue(true);
    renderPanel(null, save);
    expect(field().value).toBe('');
    await userEvent.selectOptions(field(), 'Geschäftlich');
    expect(save).toHaveBeenCalledWith('row-1', 'opt-business');
    expect(screen.queryByText(/Nicht gespeichert/)).toBeNull();
    cleanup();

    renderPanel('opt-private', save);
    expect(field().value).toBe('opt-private');
  });

  it('can be taken back to none', async () => {
    const save = vi.fn().mockResolvedValue(true);
    renderPanel('opt-private', save);
    await userEvent.selectOptions(field(), 'Keine Zuordnung');
    expect(save).toHaveBeenCalledWith('row-1', null);
  });

  it('says so when the Zuordnung was not saved, and clears that on the next try', async () => {
    const save = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    renderPanel(null, save);
    await userEvent.selectOptions(field(), 'Privat');
    expect((await screen.findByText(/Nicht gespeichert/)).getAttribute('role')).toBe('alert');
    await userEvent.selectOptions(field(), 'Geschäftlich');
    await waitFor(() => expect(screen.queryByText(/Nicht gespeichert/)).toBeNull());
  });

  it('only shows the value where no save is wired up', () => {
    renderPanel('opt-private');
    expect(screen.queryByRole('combobox', { name: 'Zuordnung' })).toBeNull();
    expect(screen.getByText('Privat')).toBeTruthy();
  });

  it('an automatic answer says so with its reason, and one click changes it', async () => {
    const save = vi.fn().mockResolvedValue(true);
    const load = vi.fn<NoteLoader>().mockResolvedValue({ assignment: 'Privat', reason: 'Drogerie: bisher immer privat.' });
    renderPanel('opt-private', save, load);
    expect(await screen.findByText('Automatisch zugeordnet: Drogerie: bisher immer privat.', { exact: false })).toBeTruthy();
    expect(load).toHaveBeenCalledWith('row-1');
    await userEvent.click(screen.getByRole('button', { name: 'Doch Geschäftlich' }));
    expect(save).toHaveBeenCalledWith('row-1', 'opt-business');
  });

  it('no note where a person or a rule set it, or the cell no longer holds the automatic answer', async () => {
    const load = vi.fn<NoteLoader>().mockResolvedValueOnce(null).mockResolvedValueOnce({ assignment: 'Privat', reason: 'x' });
    renderPanel('opt-private', vi.fn().mockResolvedValue(true), load);
    await waitFor(() => expect(load).toHaveBeenCalled());
    expect(screen.queryByText(/Automatisch zugeordnet/)).toBeNull();
    cleanup();
    renderPanel('opt-business', vi.fn().mockResolvedValue(true), load);
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    expect(screen.queryByText(/Automatisch zugeordnet/)).toBeNull();
  });

  it('a note that cannot be loaded hides only the hint', async () => {
    renderPanel('opt-private', vi.fn().mockResolvedValue(true), vi.fn<NoteLoader>().mockRejectedValue(new Error('down')));
    expect(field().value).toBe('opt-private');
    await waitFor(() => expect(screen.queryByText(/Automatisch zugeordnet/)).toBeNull());
  });
});
