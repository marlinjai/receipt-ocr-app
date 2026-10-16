import { describe, expect, it } from 'vitest';
import { editedAllocations, normalizedLegacyCells, treatmentToCells } from '../assignment';
import { legacyAllocations } from '../defaults';

describe('treatmentToCells', () => {
  it('shows a business share as business with that share, also beside study', () => {
    expect(treatmentToCells([{ purpose: 'business', shareBp: 3000 }])).toEqual({ zuordnung: 'Geschäftlich', sharePercent: 30 });
    expect(treatmentToCells([{ purpose: 'business', shareBp: 5000 }, { purpose: 'study', shareBp: 3000 }])).toEqual({ zuordnung: 'Geschäftlich', sharePercent: 50 });
  });

  it('shows study and employment together as university', () => {
    expect(treatmentToCells([{ purpose: 'study', shareBp: 10000 }])).toEqual({ zuordnung: 'Universität', sharePercent: 100 });
    expect(treatmentToCells([{ purpose: 'employment', shareBp: 4000 }, { purpose: 'private', shareBp: 6000 }])).toEqual({ zuordnung: 'Universität', sharePercent: 40 });
  });

  it('gives a private receipt one share: 0', () => {
    expect(treatmentToCells([{ purpose: 'private', shareBp: 10000 }])).toEqual({ zuordnung: 'Privat', sharePercent: 0 });
    expect(treatmentToCells([])).toEqual({ zuordnung: 'Privat', sharePercent: 0 });
  });

  it('reads back to the same treatment where one cell pair can say it (no figure moves when the cells are written)', () => {
    for (const allocations of [
      [{ purpose: 'business' as const, shareBp: 10000 }],
      [{ purpose: 'business' as const, shareBp: 3333 }],
      [{ purpose: 'study' as const, shareBp: 2500 }],
      [{ purpose: 'private' as const, shareBp: 10000 }],
    ]) {
      const cells = treatmentToCells(allocations);
      const back = legacyAllocations(cells.zuordnung, cells.sharePercent);
      expect(back?.filter((a) => a.purpose !== 'private')).toEqual(allocations.filter((a) => a.purpose !== 'private'));
    }
  });
});

describe('normalizedLegacyCells', () => {
  it('a private receipt gets the share 0, whatever it held; others are left alone', () => {
    expect(normalizedLegacyCells('Privat', 100)).toEqual({ zuordnung: 'Privat', sharePercent: 0 });
    expect(normalizedLegacyCells('Privat', null)).toEqual({ zuordnung: 'Privat', sharePercent: 0 });
    expect(normalizedLegacyCells('Geschäftlich', 40)).toBeNull();
    expect(normalizedLegacyCells(null, null)).toBeNull();
  });
});

describe('editedAllocations', () => {
  const business40 = [{ purpose: 'business' as const, shareBp: 4000 }, { purpose: 'private' as const, shareBp: 6000 }];

  it('a new assignment replaces the purposes, keeping the shown share unless one is given', () => {
    expect(editedAllocations(business40, { zuordnung: 'Universität' })).toEqual([{ purpose: 'study', shareBp: 4000 }]);
    expect(editedAllocations(business40, { zuordnung: 'Universität', sharePercent: 100 })).toEqual([{ purpose: 'study', shareBp: 10000 }]);
    expect(editedAllocations(business40, { zuordnung: 'Privat' })).toEqual([{ purpose: 'private', shareBp: 10000 }]);
  });

  it('from private to business without a share means the whole', () => {
    expect(editedAllocations([{ purpose: 'private', shareBp: 10000 }], { zuordnung: 'Geschäftlich' })).toEqual([{ purpose: 'business', shareBp: 10000 }]);
  });

  it('a new share changes only the purpose the cells show, other purposes stay, never above the whole', () => {
    expect(editedAllocations(business40, { sharePercent: 70 })).toEqual([{ purpose: 'business', shareBp: 7000 }]);
    const mixed = [{ purpose: 'business' as const, shareBp: 5000 }, { purpose: 'study' as const, shareBp: 3000 }];
    expect(editedAllocations(mixed, { sharePercent: 60 })).toEqual([{ purpose: 'business', shareBp: 6000 }, { purpose: 'study', shareBp: 3000 }]);
    expect(editedAllocations(mixed, { sharePercent: 100 })).toEqual([{ purpose: 'business', shareBp: 7000 }, { purpose: 'study', shareBp: 3000 }]);
    expect(editedAllocations([{ purpose: 'employment', shareBp: 5000 }], { sharePercent: 80 })).toEqual([{ purpose: 'employment', shareBp: 8000 }]);
  });

  it('share 0 for business is private; a cleared assignment is null; an unknown one is null', () => {
    expect(editedAllocations(business40, { sharePercent: 0 })).toEqual([{ purpose: 'private', shareBp: 10000 }]);
    expect(editedAllocations(business40, { zuordnung: null })).toBeNull();
    expect(editedAllocations(business40, { zuordnung: '' })).toBeNull();
    expect(editedAllocations(business40, { zuordnung: 'Halb' })).toBeNull();
  });

  it('a share outside 0 to 100 is held to it', () => {
    expect(editedAllocations(business40, { sharePercent: 250 })).toEqual([{ purpose: 'business', shareBp: 10000 }]);
  });
});
