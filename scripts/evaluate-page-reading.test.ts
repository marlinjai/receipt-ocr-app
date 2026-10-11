import { describe, expect, it } from 'vitest';
import { parseCsv, pickSample } from './evaluate-page-reading';

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
