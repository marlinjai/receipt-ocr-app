// @vitest-environment jsdom
import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { openOfflineStore } from '@/lib/offline/receipts-db';
import type { SyncDeps } from '@/lib/offline/sync';
import { OFFLINE_SAVE_DELAY_MS, OfflineSnapshot } from '../OfflineSnapshot';

let deps: SyncDeps;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  fetchMock = vi.fn(async () => new Response(JSON.stringify({ workspaceId: 'ws-a', company: 'A', receipts: [] }), { status: 200 }));
  deps = { store: openOfflineStore(new IDBFactory()), fetch: fetchMock as unknown as typeof fetch, now: () => Date.now() };
});
afterEach(() => vi.useRealTimers());

describe('OfflineSnapshot', () => {
  it('saves only after the page settled, not while it loads', async () => {
    render(<OfflineSnapshot workspaceId="ws-a" deps={deps} />);
    await act(async () => vi.advanceTimersByTime(OFFLINE_SAVE_DELAY_MS - 1));
    expect(fetchMock).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTime(1));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  });

  it('a company switch before the delay: nothing is asked for the company left', async () => {
    const view = render(<OfflineSnapshot workspaceId="ws-a" deps={deps} />);
    view.unmount();
    await act(async () => vi.advanceTimersByTime(OFFLINE_SAVE_DELAY_MS));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a company switch while the answer is on its way stops it: the signal handed to the request aborts', async () => {
    let signal: AbortSignal | undefined;
    fetchMock.mockImplementationOnce((_url: string, init: RequestInit) => {
      signal = init.signal ?? undefined;
      return new Promise<Response>(() => {});
    });
    const view = render(<OfflineSnapshot workspaceId="ws-a" deps={deps} />);
    await act(async () => vi.advanceTimersByTime(OFFLINE_SAVE_DELAY_MS));
    await vi.waitFor(() => expect(signal).toBeDefined());
    view.unmount();
    expect(signal!.aborted).toBe(true);
  });

  it('asks nothing while the device is offline', async () => {
    const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    render(<OfflineSnapshot workspaceId="ws-a" deps={deps} />);
    await act(async () => vi.advanceTimersByTime(OFFLINE_SAVE_DELAY_MS));
    expect(fetchMock).not.toHaveBeenCalled();
    online.mockRestore();
  });
});
