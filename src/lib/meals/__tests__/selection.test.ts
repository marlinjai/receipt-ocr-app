import { describe, expect, it } from 'vitest';
import { pruneSelection, selectAllState, toggleAll, toggleSelected } from '../selection';

const IDS = ['a', 'b', 'c'];

describe('selection of a list with batch actions', () => {
  it('toggles one entry in and out without touching the given set', () => {
    const start = new Set(['a']);
    const added = toggleSelected(start, 'b');
    expect([...added].sort()).toEqual(['a', 'b']);
    expect([...toggleSelected(added, 'a')]).toEqual(['b']);
    expect([...start]).toEqual(['a']);
  });

  it('select all: everything when nothing or only some are selected, nothing when all are', () => {
    expect([...toggleAll(new Set(), IDS)]).toEqual(IDS);
    expect([...toggleAll(new Set(['b']), IDS)]).toEqual(IDS);
    expect([...toggleAll(new Set(IDS), IDS)]).toEqual([]);
  });

  it('reports none, some and all for the select-all box', () => {
    expect(selectAllState(new Set(), IDS)).toBe('none');
    expect(selectAllState(new Set(['c']), IDS)).toBe('some');
    expect(selectAllState(new Set(IDS), IDS)).toBe('all');
  });

  it('an empty list is never "all selected"', () => {
    expect(selectAllState(new Set(), [])).toBe('none');
    expect([...toggleAll(new Set(), [])]).toEqual([]);
  });

  it('an entry that left the list is no longer selected', () => {
    const selected = new Set(['a', 'gone', 'c']);
    expect([...pruneSelection(selected, IDS)]).toEqual(['a', 'c']);
    // "gone" must not make a fully selected list look partly selected, or the other way round.
    expect(selectAllState(new Set(['a', 'b', 'c', 'gone']), IDS)).toBe('all');
    expect(selectAllState(new Set(['gone']), IDS)).toBe('none');
  });

  it('select all after an entry left selects only what is still there', () => {
    expect([...toggleAll(new Set(['gone']), ['a', 'b'])]).toEqual(['a', 'b']);
  });
});
