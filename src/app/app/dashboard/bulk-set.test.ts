import { describe, expect, it } from 'vitest';
import { BULK_SET_PART, joinOutcomes, outcomeWording, partsOf, storedAs, unconfirmed } from './bulk-set';

describe('a selection in parts', () => {
  it('is cut into parts of at most the part size, each row once, in order', () => {
    const ids = Array.from({ length: 2 * BULK_SET_PART + 7 }, (_, i) => `r${i}`);
    const parts = partsOf([...ids, 'r0', 'r1']);
    expect(parts.map((p) => p.length)).toEqual([BULK_SET_PART, BULK_SET_PART, 7]);
    expect(parts.flat()).toEqual(ids);
  });

  it('is no part when nothing is selected', () => {
    expect(partsOf([])).toEqual([]);
  });
});

describe('what came of a run', () => {
  it('joins the parts', () => {
    const joined = joinOutcomes([
      { done: ['a'], failed: [] },
      { done: ['b'], failed: [{ rowId: 'c', reason: 'not_stored' }] },
    ]);
    expect(joined).toEqual({ done: ['a', 'b'], failed: [{ rowId: 'c', reason: 'not_stored' }] });
  });

  it('counts no row of a part without an answer as set', () => {
    expect(unconfirmed(['a', 'b'])).toEqual({
      done: [],
      failed: [
        { rowId: 'a', reason: 'unconfirmed' },
        { rowId: 'b', reason: 'unconfirmed' },
      ],
    });
  });

  it('says how many of how many were set, and why the others were not', () => {
    expect(outcomeWording({ done: ['a', 'b'], failed: [] }, 2)).toBe('2 von 2 gesetzt.');
    expect(
      outcomeWording(
        {
          done: ['a'],
          failed: [
            { rowId: 'b', reason: 'not_stored' },
            { rowId: 'c', reason: 'not_stored' },
            { rowId: 'd', reason: 'unconfirmed' },
          ],
        },
        4,
      ),
    ).toBe('1 von 4 gesetzt. 3 nicht gesetzt: 2 nicht gespeichert, 1 keine Antwort, Stand unklar.');
  });
});

describe('a stored value read back', () => {
  it('is the value asked for only when it is that option', () => {
    expect(storedAs('opt-1', 'opt-1')).toBe(true);
    expect(storedAs('opt-2', 'opt-1')).toBe(false);
    expect(storedAs(null, 'opt-1')).toBe(false);
  });

  it('is cleared when stored empty or not at all', () => {
    expect(storedAs(null, null)).toBe(true);
    expect(storedAs('', null)).toBe(true);
    expect(storedAs(undefined, null)).toBe(true);
    expect(storedAs('opt-1', null)).toBe(false);
  });
});
