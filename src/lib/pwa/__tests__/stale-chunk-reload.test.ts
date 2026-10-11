import { describe, expect, it, vi } from 'vitest';
import { STALE_CHUNK_RELOAD_SCRIPT, staleChunkReload } from '../stale-chunk-reload';

function fakeWindow(storage: 'ok' | 'throws' = 'ok') {
  const listeners: Record<string, Array<(event: unknown) => void>> = {};
  const store = new Map<string, string>();
  const reload = vi.fn();
  const win = {
    addEventListener: (type: string, listener: (event: never) => void) => {
      (listeners[type] ??= []).push(listener as (event: unknown) => void);
    },
    location: { reload },
    sessionStorage:
      storage === 'ok'
        ? { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) }
        : {
            getItem: () => {
              throw new Error('denied');
            },
            setItem: () => {
              throw new Error('denied');
            },
          },
  };
  const fire = (type: string, event: unknown) => (listeners[type] ?? []).forEach((l) => l(event));
  return { win, reload, fire };
}

describe('a page that asks for a script file of a build that is gone', () => {
  it('reloads when a script file of the app fails to load', () => {
    const { win, reload, fire } = fakeWindow();
    staleChunkReload(win);
    fire('error', { target: { tagName: 'SCRIPT', src: 'https://example.test/_next/static/chunks/abc.js' } });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('reloads on the error the app throws for it, as an error or as a rejected promise', () => {
    const a = fakeWindow();
    staleChunkReload(a.win);
    a.fire('error', { message: 'Uncaught ChunkLoadError: Failed to load chunk /_next/static/chunks/abc.js from module 1' });
    expect(a.reload).toHaveBeenCalledTimes(1);
    const b = fakeWindow();
    staleChunkReload(b.win);
    b.fire('unhandledrejection', { reason: { name: 'ChunkLoadError', message: 'Loading chunk 12 failed.' } });
    expect(b.reload).toHaveBeenCalledTimes(1);
  });

  it('reloads once: a second failure within a minute is left to show, a later one reloads again', () => {
    const { win, reload, fire } = fakeWindow();
    let time = 1_000_000;
    staleChunkReload(win, () => time);
    const failure = { target: { tagName: 'SCRIPT', src: '/_next/static/chunks/abc.js' } };
    fire('error', failure);
    time += 5_000;
    fire('error', failure);
    expect(reload).toHaveBeenCalledTimes(1);
    time += 60_000;
    fire('error', failure);
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it('leaves every other error alone: another script, an image, an ordinary exception', () => {
    const { win, reload, fire } = fakeWindow();
    staleChunkReload(win);
    fire('error', { target: { tagName: 'SCRIPT', src: 'https://other.test/widget.js' } });
    fire('error', { target: { tagName: 'IMG', src: '/_next/static/media/x.png' } });
    fire('error', { message: 'TypeError: x is not a function' });
    fire('unhandledrejection', { reason: { name: 'TypeError', message: 'failed to fetch' } });
    fire('unhandledrejection', { reason: null });
    expect(reload).not.toHaveBeenCalled();
  });

  it('never reloads without session storage, so a file that is really missing cannot loop', () => {
    const { win, reload, fire } = fakeWindow('throws');
    staleChunkReload(win);
    fire('error', { target: { tagName: 'SCRIPT', src: '/_next/static/chunks/abc.js' } });
    expect(reload).not.toHaveBeenCalled();
  });

  it('the inline script is the same function, self-contained, and runs as written', () => {
    const { win, reload, fire } = fakeWindow();
    new Function('window', STALE_CHUNK_RELOAD_SCRIPT)(win);
    fire('error', { target: { tagName: 'SCRIPT', src: '/_next/static/chunks/abc.js' } });
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
