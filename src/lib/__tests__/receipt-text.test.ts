import { describe, expect, it } from 'vitest';
import type { Row } from '@marlinjai/data-table-core';
import { likePattern, listColumns, rowsWithoutText, textColumnIds, withoutText } from '../receipt-text';

const columns = [
  { id: 'c-name', name: 'Name' },
  { id: 'c-text', name: 'OCR Text' },
];
const row = (cells: Record<string, unknown>) => ({ id: 'r', tableId: 't', cells }) as unknown as Row;

describe('the recognized text left out of the list', () => {
  it('empties only the text cell', () => {
    const r = row({ 'c-name': 'A', 'c-text': 'a long page of text' });
    const out = withoutText(r, textColumnIds(columns));
    expect(out.cells).toEqual({ 'c-name': 'A', 'c-text': '' });
    // The row it was given is not changed: the table keeps its own state.
    expect(r.cells['c-text']).toBe('a long page of text');
  });

  it('hands back the same row when there is nothing to empty', () => {
    const r = row({ 'c-name': 'A', 'c-text': '' });
    expect(withoutText(r, ['c-text'])).toBe(r);
    expect(withoutText(r, [])).toBe(r);
    const noText = row({ 'c-name': 'A' });
    expect(withoutText(noText, ['c-text'])).toBe(noText);
  });

  it('works on lists, and the grid does not show the text column', () => {
    const out = rowsWithoutText([row({ 'c-text': 'x' }), row({ 'c-text': 'y' })], ['c-text']);
    expect(out.map((r) => r.cells['c-text'])).toEqual(['', '']);
    expect(listColumns(columns).map((c) => c.name)).toEqual(['Name']);
    expect(textColumnIds([{ id: 'x', name: 'Name' }])).toEqual([]);
    // A leftover duplicate column of the same name carries no text to the browser either.
    const dup = [...columns, { id: 'c-text-2', name: 'OCR Text' }];
    expect(withoutText(row({ 'c-text': 'a', 'c-text-2': 'b' }), textColumnIds(dup)).cells).toEqual({ 'c-text': '', 'c-text-2': '' });
  });
});

describe('the search pattern', () => {
  it('takes percent, underscore and backslash literally', () => {
    expect(likePattern('50%_off\\')).toBe('%50\\%\\_off\\\\%');
    expect(likePattern('  Linode ')).toBe('%Linode%');
  });
});
