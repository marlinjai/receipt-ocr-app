import { describe, expect, it } from 'vitest';
import { batchCoverage, beyondStored, covers, coveredByOtherSources, orderBatches, overlaps, subtract } from '../coverage';

const at = (minute: number) => new Date(Date.UTC(2026, 9, 15, 12, minute));
const batch = (id: string, format: string, firstDay: string | null, lastDay: string | null, minute: number) => ({ id, format, firstDay, lastDay, createdAt: at(minute) });

describe('subtract', () => {
  it('cuts holes, ends and whole intervals, across month ends', () => {
    expect(subtract([{ from: '2025-01-01', to: '2025-12-31' }], [{ from: '2025-03-01', to: '2025-06-30' }])).toEqual([
      { from: '2025-01-01', to: '2025-02-28' },
      { from: '2025-07-01', to: '2025-12-31' },
    ]);
    expect(subtract([{ from: '2025-01-01', to: '2025-01-31' }], [{ from: '2024-12-01', to: '2025-01-31' }])).toEqual([]);
    expect(subtract([{ from: '2025-01-01', to: '2025-01-31' }], [{ from: '2025-02-01', to: '2025-02-02' }])).toEqual([{ from: '2025-01-01', to: '2025-01-31' }]);
  });
});

describe('batchCoverage', () => {
  it('an import holds its days less those older imports of other sources held; imports of one source share theirs', () => {
    const batches = [
      batch('export', 'n26_csv', '2025-01-10', '2025-06-30', 1),
      batch('list', 'enable_banking_json', '2024-12-20', '2026-01-02', 2),
      batch('export2', 'n26_csv', '2025-03-03', '2025-08-01', 3),
      batch('empty', 'n26_csv', null, null, 4),
    ];
    const coverage = batchCoverage(batches);
    expect(coverage.get('list')).toEqual([
      { from: '2024-12-20', to: '2025-01-09' },
      { from: '2025-07-01', to: '2026-01-02' },
    ]);
    // A later export of the first source loses the list's days, not its own source's.
    expect(coverage.get('export2')).toEqual([{ from: '2025-03-03', to: '2025-06-30' }]);
    expect(coverage.get('empty')).toEqual([]);
    const forExport = coveredByOtherSources(batches, 'n26_csv');
    expect(covers(forExport, '2025-03-15')).toBe(false);
    expect(covers(forExport, '2025-07-01')).toBe(true);
    expect(overlaps(coverage.get('export') ?? [], coverage.get('list') ?? [])).toBe(false);
  });
});

describe('edges', () => {
  it('several cuts, single days, a cut of the whole, cuts touching only an end', () => {
    expect(subtract([{ from: '2025-01-01', to: '2025-01-10' }], [{ from: '2025-01-02', to: '2025-01-02' }, { from: '2025-01-05', to: '2025-01-06' }])).toEqual([
      { from: '2025-01-01', to: '2025-01-01' },
      { from: '2025-01-03', to: '2025-01-04' },
      { from: '2025-01-07', to: '2025-01-10' },
    ]);
    expect(subtract([{ from: '2025-01-05', to: '2025-01-05' }], [{ from: '2025-01-05', to: '2025-01-05' }])).toEqual([]);
    expect(subtract([{ from: '2025-01-01', to: '2025-01-10' }], [{ from: '2025-01-01', to: '2025-01-10' }])).toEqual([]);
    expect(subtract([{ from: '2025-01-01', to: '2025-01-10' }], [{ from: '2024-12-01', to: '2025-01-01' }])).toEqual([{ from: '2025-01-02', to: '2025-01-10' }]);
    expect(subtract([{ from: '2025-01-01', to: '2025-01-10' }], [{ from: '2025-01-10', to: '2025-02-01' }])).toEqual([{ from: '2025-01-01', to: '2025-01-09' }]);
  });

  it('imports of the same moment are ordered by id, the same way everywhere', () => {
    const same = new Date(Date.UTC(2026, 9, 15));
    expect(orderBatches([{ id: 'b', createdAt: same }, { id: 'a', createdAt: same }]).map((b) => b.id)).toEqual(['a', 'b']);
  });

  it('on a day another source holds, as many rows per amount as it stored are the same, the rest are new', () => {
    const rows = [
      { bookingDay: '2025-06-30', amountCents: -2_000, n: 1 },
      { bookingDay: '2025-06-30', amountCents: -2_000, n: 2 },
      { bookingDay: '2025-06-30', amountCents: -700, n: 3 },
    ];
    const { beyond, same } = beyondStored(rows, [{ bookingDay: '2025-06-30', amountCents: -2_000 }]);
    expect(same.map((r) => r.n)).toEqual([1]);
    expect(beyond.map((r) => r.n)).toEqual([2, 3]);
  });
});
