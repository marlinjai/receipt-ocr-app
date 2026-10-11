/**
 * Reload once when the page asks for a script file of a build that is gone.
 *
 * Every deployment replaces the script files. A page that was loaded just
 * before or during one still names the old files; the server answers 404 and
 * the app dies with "Application error: a client-side exception has occurred"
 * (seen on 2026-10-11 on the meal register, twice in one afternoon). A reload
 * fetches the page of the new build, and that is all the person could do
 * anyway, so the page does it itself.
 *
 * Once only: a reload is noted in the session storage with its time, and a
 * second failure within a minute is left to show, so a file that is really
 * missing can never loop. Without session storage nothing is reloaded, for the
 * same reason. The function must stay self-contained: it is written into the
 * page as text (see `STALE_CHUNK_RELOAD_SCRIPT`) and runs before any script
 * file of the app has loaded.
 */

interface ReloadWindow {
  addEventListener: (type: string, listener: (event: never) => void, capture?: boolean) => void;
  location: { reload: () => void };
  sessionStorage: { getItem: (key: string) => string | null; setItem: (key: string, value: string) => void };
}

export function staleChunkReload(win: ReloadWindow, now: () => number = Date.now): void {
  const KEY = 'receipts-stale-chunk-reload';
  const WINDOW_MS = 60_000;
  const isStale = (text: unknown) => typeof text === 'string' && /ChunkLoadError|Loading chunk|Failed to load chunk|Loading CSS chunk/i.test(text);
  const reloadOnce = () => {
    try {
      const last = Number(win.sessionStorage.getItem(KEY) || 0);
      if (now() - last < WINDOW_MS) return;
      win.sessionStorage.setItem(KEY, String(now()));
    } catch {
      return;
    }
    win.location.reload();
  };
  win.addEventListener(
    'error',
    ((event: { target?: { tagName?: string; src?: string } | null; message?: unknown; error?: { name?: unknown; message?: unknown } | null }) => {
      const target = event.target;
      // A script file of the app that failed to load at all (the 404 itself).
      if (target && target.tagName === 'SCRIPT' && typeof target.src === 'string' && target.src.indexOf('/_next/static/') !== -1) return reloadOnce();
      if (isStale(event.message) || isStale(event.error?.name) || isStale(event.error?.message)) reloadOnce();
    }) as (event: never) => void,
    true,
  );
  win.addEventListener('unhandledrejection', ((event: { reason?: { name?: unknown; message?: unknown } | null }) => {
    if (isStale(event.reason?.name) || isStale(event.reason?.message)) reloadOnce();
  }) as (event: never) => void);
}

/** The function above as the text of an inline script. */
export const STALE_CHUNK_RELOAD_SCRIPT = `(${staleChunkReload.toString()})(window);`;
