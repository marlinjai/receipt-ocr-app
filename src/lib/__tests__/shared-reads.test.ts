import { describe, expect, it, vi } from 'vitest';
import { sharedRead, withSharedReads } from '../shared-reads';

describe('sharedRead', () => {
  it('reads each key once inside a scope, also for callers side by side', async () => {
    const read = vi.fn(async () => ['row']);
    const [a, b, c] = await withSharedReads(() => Promise.all([sharedRead('rows:t', read), sharedRead('rows:t', read), sharedRead('rows:t', read)]));
    expect(read).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it('keeps different keys apart', async () => {
    const read = vi.fn(async (key: string) => key);
    const answers = await withSharedReads(() => Promise.all([sharedRead('payments:a', () => read('a')), sharedRead('payments:b', () => read('b'))]));
    expect(answers).toEqual(['a', 'b']);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('reads every time outside a scope', async () => {
    const read = vi.fn(async () => 1);
    await sharedRead('rows:t', read);
    await sharedRead('rows:t', read);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('does not keep a failed read: the next caller tries again', async () => {
    const read = vi.fn().mockRejectedValueOnce(new Error('database down')).mockResolvedValueOnce('rows');
    await withSharedReads(async () => {
      await expect(sharedRead('rows:t', read)).rejects.toThrow('database down');
      await expect(sharedRead('rows:t', read)).resolves.toBe('rows');
    });
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('gives each scope its own reads: a second page reads afresh', async () => {
    const read = vi.fn(async () => ({}));
    const first = await withSharedReads(() => sharedRead('rows:t', read));
    const second = await withSharedReads(() => sharedRead('rows:t', read));
    expect(read).toHaveBeenCalledTimes(2);
    expect(first).not.toBe(second);
  });
});
