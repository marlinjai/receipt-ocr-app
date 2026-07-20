import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  parseSpreadsheetId,
  gridToRows,
  listSheetTabs,
  readSheetValues,
  SheetsApiError,
} from './sheets-client';

afterEach(() => vi.restoreAllMocks());

describe('parseSpreadsheetId', () => {
  it('extracts the id from a full Sheets URL', () => {
    expect(
      parseSpreadsheetId('https://docs.google.com/spreadsheets/d/1iyxmO0DHBHwwFHFSjYP49keizndQEucYylCYEGtKLsg/edit?usp=drive_web'),
    ).toBe('1iyxmO0DHBHwwFHFSjYP49keizndQEucYylCYEGtKLsg');
  });
  it('accepts a bare id', () => {
    expect(parseSpreadsheetId('1iyxmO0DHBHwwFHFSjYP49keizndQEucYylCYEGtKLsg')).toBe('1iyxmO0DHBHwwFHFSjYP49keizndQEucYylCYEGtKLsg');
  });
  it('rejects junk', () => {
    expect(parseSpreadsheetId('not a sheet')).toBeNull();
    expect(parseSpreadsheetId('')).toBeNull();
  });
});

describe('gridToRows', () => {
  it('maps rows to objects keyed by header, padding short rows and skipping blanks', () => {
    const grid = [
      ['Vendor', 'Betrag', 'Datum'],
      ['Anthropic', '1.234,56', '20.07.2026'],
      ['', '', ''],
      ['Google', '9,99'],
    ];
    const { headers, rows } = gridToRows(grid, 1);
    expect(headers).toEqual(['Vendor', 'Betrag', 'Datum']);
    expect(rows).toEqual([
      { Vendor: 'Anthropic', Betrag: '1.234,56', Datum: '20.07.2026' },
      { Vendor: 'Google', Betrag: '9,99', Datum: '' },
    ]);
  });
  it('honours a non-first header row', () => {
    const grid = [['title banner'], ['Vendor', 'Amount'], ['X', '5']];
    const { headers, rows } = gridToRows(grid, 2);
    expect(headers).toEqual(['Vendor', 'Amount']);
    expect(rows).toEqual([{ Vendor: 'X', Amount: '5' }]);
  });
});

describe('Sheets API calls', () => {
  it('lists tab titles', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ sheets: [{ properties: { title: 'Invoices' } }, { properties: { title: 'Sheet2' } }] }), { status: 200 }),
    ));
    expect(await listSheetTabs('tok', 'sid')).toEqual(['Invoices', 'Sheet2']);
  });

  it('reads values (empty grid when absent)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ values: [['a', 'b']] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await readSheetValues('tok', 'sid', 'Invoices')).toEqual([['a', 'b']]);
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer tok');
  });

  it('throws SheetsApiError on a non-2xx (e.g. 403 no access)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('denied', { status: 403 })));
    await expect(listSheetTabs('tok', 'sid')).rejects.toBeInstanceOf(SheetsApiError);
  });
});
