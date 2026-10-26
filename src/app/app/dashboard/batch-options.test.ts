import { describe, expect, it, vi } from 'vitest';
import type { SelectOption } from '@marlinjai/data-table-core';
import { batchedSelectOptions } from './batch-options';

const option = (columnId: string, name: string) => ({ id: `${columnId}-${name}`, columnId, name, position: 0 }) as unknown as SelectOption;

describe('batchedSelectOptions', () => {
  it('asks once for the columns asked for in the same moment, each caller getting its own', async () => {
    const load = vi.fn(async (ids: string[]) => Object.fromEntries(ids.map((id) => [id, [option(id, 'A')]])));
    const ask = batchedSelectOptions(load);
    const [category, currency, again] = await Promise.all([ask('category'), ask('currency'), ask('category')]);
    expect(load).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledWith(['category', 'currency']);
    expect(category).toEqual([option('category', 'A')]);
    expect(currency).toEqual([option('currency', 'A')]);
    expect(again).toEqual(category);
  });

  it('asks afresh later: an option added in between is there', async () => {
    let names = ['A'];
    const load = vi.fn(async (ids: string[]) => Object.fromEntries(ids.map((id) => [id, names.map((n) => option(id, n))])));
    const ask = batchedSelectOptions(load);
    expect(await ask('category')).toHaveLength(1);
    names = ['A', 'B'];
    expect(await ask('category')).toHaveLength(2);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('gives a column the answer has no entry for no options', async () => {
    const ask = batchedSelectOptions(async () => ({}));
    await expect(ask('removed')).resolves.toEqual([]);
  });

  it('fails every ask a failed call carried, and the next moment tries again', async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ category: [option('category', 'A')] });
    const ask = batchedSelectOptions(load);
    const results = await Promise.allSettled([ask('category'), ask('currency')]);
    expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected']);
    await expect(ask('category')).resolves.toEqual([option('category', 'A')]);
  });
});
