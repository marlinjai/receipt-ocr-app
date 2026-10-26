import { afterEach, describe, expect, it, vi } from 'vitest';
import { measurePage, timed } from '../timing';

/** A clock that moves only when the test says so. */
function clock() {
  let now = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  return (ms: number) => {
    now += ms;
  };
}

afterEach(() => vi.restoreAllMocks());

describe('measurePage', () => {
  it('writes each step of a slow page, nested steps included', async () => {
    const advance = clock();
    const log = vi.spyOn(console, 'info').mockImplementation(() => {});
    const inner = () => timed('rows', async () => advance(600));
    const result = await measurePage('/app/dashboard', async () => {
      await timed('auth', async () => advance(100));
      await timed('review', inner);
      return 'page';
    });
    expect(result).toBe('page');
    expect(log).toHaveBeenCalledWith('[timing] /app/dashboard 700ms: auth 100, rows 600, review 600');
  });

  it('writes nothing for a fast page', async () => {
    const advance = clock();
    const log = vi.spyOn(console, 'info').mockImplementation(() => {});
    await measurePage('/app', () => timed('auth', async () => advance(50)));
    expect(log).not.toHaveBeenCalled();
  });

  it('still writes the steps when the page fails, and passes the failure on', async () => {
    const advance = clock();
    const log = vi.spyOn(console, 'info').mockImplementation(() => {});
    const failing = measurePage('/app/spending', () =>
      timed('spending', async () => {
        advance(900);
        throw new Error('database down');
      }),
    );
    await expect(failing).rejects.toThrow('database down');
    expect(log).toHaveBeenCalledWith('[timing] /app/spending 900ms: spending 900');
  });

  it('keeps two pages measured at the same time apart', async () => {
    const advance = clock();
    const log = vi.spyOn(console, 'info').mockImplementation(() => {});
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const first = measurePage('/a', () => timed('a-step', () => gate));
    const second = measurePage('/b', () => timed('b-step', async () => advance(800)));
    await second;
    release();
    await first;
    expect(log.mock.calls).toEqual([['[timing] /b 800ms: b-step 800'], ['[timing] /a 800ms: a-step 800']]);
  });
});

describe('timed', () => {
  it('only runs the step outside a measurement', async () => {
    const log = vi.spyOn(console, 'info').mockImplementation(() => {});
    await expect(timed('alone', async () => 42)).resolves.toBe(42);
    expect(log).not.toHaveBeenCalled();
  });
});
