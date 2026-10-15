import { describe, expect, it } from 'vitest';
import { expectedRows, judge, judgeVendor, parseCsv, pickSample, tableDay, tally } from './evaluate-page-reading';

describe('parseCsv', () => {
  it('reads quoted fields with commas, doubled quotes and line breaks', () => {
    const rows = parseCsv('﻿file,vendor,note\r\na.pdf,"Beispiel, Inc.","said ""paid""\nin full"\nb.pdf,Muster,\n');
    expect(rows).toEqual([
      { file: 'a.pdf', vendor: 'Beispiel, Inc.', note: 'said "paid"\nin full' },
      { file: 'b.pdf', vendor: 'Muster', note: '' },
    ]);
  });
});

describe('pickSample', () => {
  const rows = [
    ...Array.from({ length: 10 }, (_, i) => ({ vendor: 'Viel GmbH', file: `viel-${i}` })),
    ...Array.from({ length: 4 }, (_, i) => ({ vendor: 'Zoll Express', file: `zoll-${i}` })),
    { vendor: 'Einmal AG', file: 'einmal' },
    { vendor: 'Selten KG', file: 'selten' },
  ];

  it('takes up to three documents of an insisted vendor, then one per other vendor in turn', () => {
    const picked = pickSample(rows, 7, ['zoll']).map((r) => r.file);
    expect(picked).toEqual(['zoll-0', 'zoll-1', 'zoll-2', 'viel-0', 'einmal', 'selten', 'viel-1']);
  });

  it('never returns more than asked for, and all there is when asked for more', () => {
    expect(pickSample(rows, 2, [])).toHaveLength(2);
    expect(pickSample(rows, 100, [])).toHaveLength(rows.length);
  });
});

describe('the table of the tax folder', () => {
  const csv = [
    'file,sha256,pages,company,decision,reason,receipt_id,vendor,total,currency,eur,date,assignment,share',
    'Kaufbelege/2026/a.pdf,x,1,Firma,imported,,r1,Musterhost,34.51,USD,30.33,"Jul 24, 2026",Geschäftlich,100',
    'Kaufbelege/2026/b.pdf,x,1,,not uploaded,same invoice,,,,,,,,',
    '"Steuern/2026/Eingang/scan.pdf, page 3",x,1,Firma,imported,,r2,Bäckerei,4.20,EUR,4.20,"Mar 3, 2026",Privat,0',
    'Kaufbelege/2026/c.pdf,x,1,Firma,imported,,r3,Beispiel,12.00,EUR,12.00,"Feb 30, 2026",Privat,0',
    'Kaufbelege/2026/d.pdf,x,1,Firma,imported,,r4,Ohne Datum,7.50,,7.50,,Privat,0',
  ].join('\n');

  it('reads the imported rows with their date, total and currency, and skips what it cannot judge', () => {
    expect(expectedRows(csv)).toEqual([
      { file: 'Kaufbelege/2026/a.pdf', vendor: 'Musterhost', date: '2026-07-24', total: 34.51, vat: null, currency: 'USD' },
      { file: 'Kaufbelege/2026/d.pdf', vendor: 'Ohne Datum', date: null, total: 7.5, vat: null, currency: null },
    ]);
  });

  it('still reads the hand-checked table of 2025', () => {
    expect(expectedRows('file,vendor,invoice_date,total_gross,vat_amount\nx.pdf,Muster,2025-03-01,11.90,1.90')).toEqual([
      { file: 'x.pdf', vendor: 'Muster', date: '2025-03-01', total: 11.9, vat: 1.9, currency: null },
    ]);
  });

  it('reads both ways of writing a day, and no day that does not exist', () => {
    expect(tableDay('2026-07-24')).toBe('2026-07-24');
    expect(tableDay('Jul 24, 2026')).toBe('2026-07-24');
    expect(tableDay('Sept 3, 2026')).toBe('2026-09-03');
    expect(tableDay('Feb 30, 2026')).toBeNull();
    expect(tableDay('24.07.2026')).toBeNull();
  });
});

describe('the vendor cell is judged', () => {
  it('the same name, without its legal form or inside a longer one, is right', () => {
    expect(judgeVendor('Musterhost', 'Musterhost Online GmbH')).toBe('correct');
    expect(judgeVendor('A2 Hosting', 'A2 Hosting LLC')).toBe('correct');
  });

  it('a legal entity for the name a customer uses is wrong, an empty one missing, an unknown table name not judged', () => {
    expect(judgeVendor('Editor', 'Example Holdings, Inc.')).toBe('wrong');
    expect(judgeVendor('Editor', null)).toBe('missing');
    expect(judgeVendor('unknown', 'Editor')).toBe('not judged');
  });

  it('is counted in the tally next to date and total, with the currency', () => {
    const expected = { file: 'a.pdf', vendor: 'Musterhost', date: '2026-07-24', total: 34.51, vat: null, currency: 'USD' };
    const right = judge(expected, { date: '2026-07-24T00:00:00.000Z', gross: 34.51, net: 34.51, flags: [], vendor: 'Musterhost LLC', currency: 'USD' }, 'Musterhost', true);
    const wrong = judge(expected, { date: '2026-07-24T00:00:00.000Z', gross: 34.51, net: 34.51, flags: [], vendor: 'Other Corp', currency: 'EUR' }, 'Musterhost', true);
    expect(right).toMatchObject({ vendorVerdict: 'correct', currency: 'correct', date: 'correct', total: 'correct' });
    expect(tally([right, wrong])).toMatchObject({ vendor: { correct: 1, wrong: 1, missing: 0 }, currency: { correct: 1, wrong: 1 } });
  });
});
