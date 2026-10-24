import { describe, expect, it } from 'vitest';
import { rankVendors, vendorChips } from './vendor-chips';

const ranked = Array.from({ length: 12 }, (_, i) => `Händler ${String(i + 1).padStart(2, '0')}`);
const base = { ranked, off: new Set<string>(), limit: 8, expanded: false, query: '' };

describe('rankVendors', () => {
  it('puts the largest amount first and orders equal amounts by name', () => {
    expect(rankVendors([{ vendor: 'B', amount: 5 }, { vendor: 'C', amount: 50 }, { vendor: 'A', amount: 5 }], ['A', 'B', 'C', 'D'])).toEqual(['C', 'A', 'B', 'D']);
  });
});

describe('vendorChips', () => {
  it('shows every vendor and offers no folding when they fit the limit', () => {
    expect(vendorChips({ ...base, ranked: ranked.slice(0, 8) })).toEqual({ shown: ranked.slice(0, 8), folded: 0, foldable: false });
  });

  it('folds to the top vendors and counts what it leaves out', () => {
    const chips = vendorChips(base);
    expect(chips.shown).toEqual(ranked.slice(0, 8));
    expect(chips).toMatchObject({ folded: 4, foldable: true });
  });

  it('never folds away a vendor that is switched off, so the selection stays visible', () => {
    const chips = vendorChips({ ...base, off: new Set(['Händler 11']) });
    expect(chips.shown).toEqual([...ranked.slice(0, 8), 'Händler 11']);
    expect(chips.folded).toBe(3);
  });

  it('shows everything when unfolded, and the search narrows it but keeps switched-off vendors', () => {
    expect(vendorChips({ ...base, expanded: true }).shown).toEqual(ranked);
    const searched = vendorChips({ ...base, expanded: true, query: ' 1', off: new Set(['Händler 03']) });
    expect(searched.shown).toEqual(['Händler 01', 'Händler 03', 'Händler 10', 'Händler 11', 'Händler 12']);
  });

  it('ignores case in the search', () => {
    expect(vendorChips({ ...base, expanded: true, query: 'HÄNDLER 12' }).shown).toEqual(['Händler 12']);
  });
});
