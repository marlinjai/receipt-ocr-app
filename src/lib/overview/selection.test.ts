import { describe, it, expect } from 'vitest';
import { applySelection, presetFrom, sanitizeSelectionDef, type LedgerInvoice } from './selection';

const NOW = new Date('2026-07-22T12:00:00Z');

const inv = (id: string, over: Partial<LedgerInvoice> = {}): LedgerInvoice => ({
  id,
  name: null,
  vendor: 'Anthropic (Claude)',
  currency: 'EUR',
  amountNative: 100,
  fxRate: 1,
  businessShare: 30,
  date: '2026-07-01',
  ...over,
});

const LEDGER: LedgerInvoice[] = [
  inv('a', { date: '2026-07-20' }), // 2 days ago
  inv('b', { date: '2026-05-01' }), // ~3 months window edge
  inv('c', { date: '2026-01-15', vendor: 'ElevenLabs', currency: 'USD' }),
  inv('d', { date: '2025-06-01', vendor: 'Google Workspace' }), // > 1y ago
  inv('e', { date: null }), // undated
];

describe('presetFrom', () => {
  it('computes preset windows relative to now (UTC)', () => {
    expect(presetFrom('1w', NOW)).toBe('2026-07-15');
    expect(presetFrom('1m', NOW)).toBe('2026-06-22');
    expect(presetFrom('3m', NOW)).toBe('2026-04-22');
    expect(presetFrom('6m', NOW)).toBe('2026-01-22');
    expect(presetFrom('1y', NOW)).toBe('2025-07-22');
    expect(presetFrom('ytd', NOW)).toBe('2026-01-01');
    expect(presetFrom('all', NOW)).toBeNull();
  });
});

describe('applySelection', () => {
  it('all: keeps everything including undated', () => {
    expect(applySelection(LEDGER, {}, NOW).map((i) => i.id)).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('presets bound the window and drop undated invoices', () => {
    expect(applySelection(LEDGER, { preset: '1w' }, NOW).map((i) => i.id)).toEqual(['a']);
    expect(applySelection(LEDGER, { preset: '3m' }, NOW).map((i) => i.id)).toEqual(['a', 'b']);
    expect(applySelection(LEDGER, { preset: 'ytd' }, NOW).map((i) => i.id)).toEqual(['a', 'b', 'c']);
    expect(applySelection(LEDGER, { preset: '1y' }, NOW).map((i) => i.id)).toEqual(['a', 'b', 'c']);
  });

  it('custom range is inclusive on both ends', () => {
    const ids = applySelection(LEDGER, { preset: 'custom', from: '2026-01-15', to: '2026-05-01' }, NOW).map((i) => i.id);
    expect(ids).toEqual(['b', 'c']);
  });

  it('filters by vendor and currency (living filters)', () => {
    expect(applySelection(LEDGER, { vendors: ['ElevenLabs'] }, NOW).map((i) => i.id)).toEqual(['c']);
    expect(applySelection(LEDGER, { currencies: ['EUR'] }, NOW).map((i) => i.id)).toEqual(['a', 'b', 'd', 'e']);
  });

  it('includeIds keeps only the frozen set; excludeIds removes theirs', () => {
    expect(applySelection(LEDGER, { includeIds: ['b', 'e'] }, NOW).map((i) => i.id)).toEqual(['b', 'e']);
    expect(applySelection(LEDGER, { excludeIds: ['a', 'c'] }, NOW).map((i) => i.id)).toEqual(['b', 'd', 'e']);
  });

  it('mixes filters: vendor + range + exclusion in one definition', () => {
    const def = { preset: 'custom' as const, from: '2026-01-01', to: '2026-12-31', vendors: ['Anthropic (Claude)'], excludeIds: ['b'] };
    expect(applySelection(LEDGER, def, NOW).map((i) => i.id)).toEqual(['a']);
  });
});

describe('sanitizeSelectionDef', () => {
  it('keeps valid fields and drops junk', () => {
    expect(
      sanitizeSelectionDef({
        preset: '3m',
        from: 'not-a-date',
        vendors: ['A', 7, ''],
        includeIds: ['x'],
        bogus: true,
      }),
    ).toEqual({ preset: '3m', vendors: ['A'], includeIds: ['x'] });
  });
  it('handles non-objects', () => {
    expect(sanitizeSelectionDef(null)).toEqual({});
    expect(sanitizeSelectionDef('nope')).toEqual({});
  });
  it('rejects unknown presets', () => {
    expect(sanitizeSelectionDef({ preset: '2w' })).toEqual({});
  });
});
