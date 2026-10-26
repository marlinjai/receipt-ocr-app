import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StoredReading } from '../reading';

vi.mock('server-only', () => ({}));
const counting = vi.hoisted(() => ({ calls: 0 }));
vi.mock('../reading', async (original) => {
  const real = await original<typeof import('../reading')>();
  return {
    ...real,
    newReading: (stored: StoredReading) => {
      counting.calls += 1;
      return real.newReading(stored);
    },
  };
});

const { cachedReading, forgetReadings, readingCacheSize } = await import('../reading-cache');
const { newReading } = await import('../reading');

/** A till receipt whose stored total is the old reader's (it included the tip). */
const stored: StoredReading = {
  name: 'Cafe Nord',
  vendor: 'Cafe Nord',
  gross: 12.5,
  net: null,
  taxRate: null,
  currency: 'EUR',
  tip: null,
  category: 'Bewirtung',
  text: 'Cafe Nord\nCappuccino 3,50\nKuchen 4,50\nSumme 8,00\nMwSt 19% 1,28\nNetto 6,72\nTrinkgeld 4,50\nGesamt 12,50',
};

beforeEach(() => {
  forgetReadings();
  counting.calls = 0;
});

describe('cachedReading', () => {
  it('answers as the reading itself does, and reads a receipt once', () => {
    const first = cachedReading(stored);
    const again = cachedReading({ ...stored });
    expect(first).toEqual(newReading(stored));
    expect(again).toEqual(first);
    // Two asks of the cache plus the comparison's own reading above.
    expect(counting.calls).toBe(2);
  });

  it('reads again when anything it is read from changed', () => {
    cachedReading(stored);
    cachedReading({ ...stored, text: `${stored.text}\nDanke` });
    cachedReading({ ...stored, gross: 8 });
    expect(counting.calls).toBe(3);
  });

  it('hands out copies: a caller that changes its answer does not change the next one', () => {
    const first = cachedReading(stored);
    first.changes.length = 0;
    first.taxLines.push({ rate: 7, net: 1, tax: 0.07 });
    expect(cachedReading(stored)).toEqual(newReading(stored));
  });

  it('keeps at most 5,000 readings, dropping the oldest unused first', () => {
    cachedReading(stored);
    for (let i = 0; i < 5_000; i++) {
      cachedReading({ ...stored, text: '', name: `Beleg ${i}` });
      // The first receipt stays in use, so it is never the oldest.
      if (i % 1_000 === 0) cachedReading(stored);
    }
    expect(readingCacheSize()).toBe(5_000);
    const before = counting.calls;
    cachedReading(stored);
    expect(counting.calls).toBe(before);
    // The first of the empty receipts was the oldest unused one: it is read again.
    cachedReading({ ...stored, text: '', name: 'Beleg 0' });
    expect(counting.calls).toBe(before + 1);
  });
});
