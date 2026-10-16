import { describe, expect, it } from 'vitest';
import { compareRow, parseExport, tally } from './rerun-stored-readings';

/** Invented texts in the layout of real ones. */
const TILL = ['Musterladen', 'Datum 14.03.2026', 'Netto 10,00', 'MwSt 19% 1,90', 'Summe 11,90'].join('\n');

describe('compareRow', () => {
  it('agrees where the stored date and total are what the reader reads', () => {
    expect(compareRow({ id: 'a', text: TILL, date: '2026-03-14T00:00:00.000Z', gross: 11.9, currency: 'EUR' })).toEqual({ id: 'a', date: 'agree', total: 'agree' });
  });

  it('differs where they are not, and says whether the reader is sure of its own total', () => {
    expect(compareRow({ id: 'b', text: TILL, date: '2026-03-15', gross: 10, currency: 'EUR' })).toEqual({ id: 'b', date: 'differ', total: 'differ', readerSure: true });
    const unsure = 'Musterladen\nDatum 14.03.2026\nGesamt 20,00';
    expect(compareRow({ id: 'c', text: unsure, date: '2026-03-14', gross: 25, currency: 'EUR' })).toMatchObject({ total: 'differ', readerSure: false });
  });

  it('a stored total the reader settles on when handed it as the page reading counts as agreeing', () => {
    // The text proves the taxed part (57.09); the total above it less the tax is printed: a page reading of 226.14 stands.
    const customs = ['Zollrechnung', 'Datum 14.05.2025', 'Abgaben 169,05', 'Gesamt 226,14', 'Netto 47,97', 'EUSt 19% 9,12', '57,09', '217,02'].join('\n');
    expect(compareRow({ id: 'd', text: customs, date: '2025-05-14', gross: 226.14, currency: 'EUR' })?.total).toBe('agree');
  });

  it('nothing stored, nothing read, and no text at all', () => {
    expect(compareRow({ id: 'e', text: TILL, date: null, gross: null, currency: null })).toMatchObject({ date: 'stored_none', total: 'stored_none' });
    expect(compareRow({ id: 'f', text: 'Musterladen\nDanke', date: '2026-03-14', gross: 5, currency: null })).toMatchObject({ date: 'read_none', total: 'read_none' });
    expect(compareRow({ id: 'g', text: '   ', date: '2026-03-14', gross: 5, currency: null })).toBeNull();
  });
});

describe('tally', () => {
  it('counts verdicts and the shape of the stored texts, and names only the ids that differ', () => {
    const { tally: t, differing } = tally([
      { id: 'a', text: TILL, date: '2026-03-14', gross: 11.9, currency: 'EUR' },
      { id: 'b', text: TILL, date: '2026-03-15', gross: 11.9, currency: 'EUR' },
      { id: 'c', text: 'Summe:\n\n11,90', date: null, gross: null, currency: null },
      { id: 'd', text: '', date: null, gross: null, currency: null },
    ]);
    expect(t).toMatchObject({ receipts: 4, withoutText: 1, date: { agree: 1, differ: 1, stored_none: 1 }, total: { agree: 2, stored_none: 1 }, text: { withEmptyLines: 1, withLabelBeforeEmptyLine: 1 } });
    expect(differing).toEqual(['b']);
  });
});

describe('parseExport', () => {
  it('reads rows and refuses what it cannot read', () => {
    expect(parseExport(JSON.stringify([{ id: 'a', text: 'x', date: '2026-03-14', gross: '11.90', currency: 'USD' }]))).toEqual([{ id: 'a', text: 'x', date: '2026-03-14', gross: 11.9, currency: 'USD' }]);
    expect(parseExport(JSON.stringify([{ id: 'a', text: 'x' }]))).toEqual([{ id: 'a', text: 'x', date: null, gross: null, currency: null }]);
    expect(() => parseExport('{}')).toThrow('JSON array');
    expect(() => parseExport(JSON.stringify([{ id: 'a' }]))).toThrow('no id or no text');
    expect(() => parseExport(JSON.stringify([{ id: 'a', text: 'x', gross: 'zwölf' }]))).toThrow('no number');
  });
});
