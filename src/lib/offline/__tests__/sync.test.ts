import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { openOfflineStore, type OfflineReceiptsResponse, type OfflineSnapshot, type OfflineStore } from '../receipts-db';
import { OFFLINE_FRESH_MS, clearOfflineSnapshot, resetOfflineSyncForTests, syncOfflineSnapshot, type SyncDeps } from '../sync';

const NOW = Date.UTC(2026, 10, 28, 10);
const receipt = { id: 'r1', date: '2026-11-02', name: 'Coop', vendor: null, gross: 12.5, currency: 'EUR', eur: 12.5, category: null, status: 'Offen', assignment: null };
const answer = (workspaceId = 'ws-a'): OfflineReceiptsResponse => ({ workspaceId, company: 'Firma A', receipts: [receipt] });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

let factory: IDBFactory;
let store: OfflineStore;
let fetchMock: ReturnType<typeof vi.fn>;
let deps: SyncDeps;

const kept = async () => (await store.read()).snapshot;
const keep = async (snapshot: OfflineSnapshot) => store.write(snapshot, (await store.read()).deletions);
const live = () => new AbortController().signal;

beforeEach(() => {
  resetOfflineSyncForTests();
  factory = new IDBFactory();
  store = openOfflineStore(factory);
  fetchMock = vi.fn(async () => json(answer()));
  deps = { store, fetch: fetchMock as unknown as typeof fetch, now: () => NOW };
});

describe('syncOfflineSnapshot', () => {
  it('saves the list when none is kept, and not again while it is younger than an hour', async () => {
    expect(await syncOfflineSnapshot('ws-a', live(), deps)).toBe('saved');
    expect(await kept()).toEqual({ ...answer(), savedAt: NOW });
    expect(await syncOfflineSnapshot('ws-a', live(), { ...deps, now: () => NOW + OFFLINE_FRESH_MS - 1 })).toBe('fresh');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await syncOfflineSnapshot('ws-a', live(), { ...deps, now: () => NOW + OFFLINE_FRESH_MS })).toBe('saved');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('a clock set back does not make the kept list look new', async () => {
    await keep({ ...answer(), savedAt: NOW });
    expect(await syncOfflineSnapshot('ws-a', live(), { ...deps, now: () => NOW - 1000 })).toBe('saved');
  });

  it('replaces a fresh list of another company', async () => {
    await keep({ ...answer('ws-b'), savedAt: NOW });
    expect(await syncOfflineSnapshot('ws-a', live(), deps)).toBe('saved');
    expect((await kept())?.workspaceId).toBe('ws-a');
  });

  it('deletes the list when the server refuses the session (401 and 403)', async () => {
    for (const status of [401, 403]) {
      await keep({ ...answer('ws-b'), savedAt: NOW });
      fetchMock.mockResolvedValueOnce(json({ error: 'unauthorized' }, status));
      expect(await syncOfflineSnapshot('ws-a', live(), deps)).toBe('signed-out');
      expect(await kept()).toBeNull();
    }
  });

  it('keeps the list on an auth outage (503), a server error, a broken answer or no connection', async () => {
    const list = { ...answer('ws-b'), savedAt: NOW };
    await keep(list);
    fetchMock.mockResolvedValueOnce(json({ error: 'auth_unavailable' }, 503));
    expect(await syncOfflineSnapshot('ws-a', live(), deps)).toBe('failed');
    fetchMock.mockResolvedValueOnce(json({ error: 'read_failed' }, 500));
    expect(await syncOfflineSnapshot('ws-a', live(), deps)).toBe('failed');
    fetchMock.mockResolvedValueOnce(new Response('<html>', { status: 200 }));
    expect(await syncOfflineSnapshot('ws-a', live(), deps)).toBe('failed');
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    expect(await syncOfflineSnapshot('ws-a', live(), deps)).toBe('failed');
    expect(await kept()).toEqual(list);
  });

  it('an answer for another company than this page shows is not written, and the old list goes', async () => {
    await keep({ ...answer(), savedAt: NOW - OFFLINE_FRESH_MS });
    fetchMock.mockResolvedValueOnce(json(answer('ws-b')));
    expect(await syncOfflineSnapshot('ws-a', live(), deps)).toBe('failed');
    expect(await kept()).toBeNull();
  });

  it('a company switch while the answer is on its way: the answer is not written', async () => {
    const switched = new AbortController();
    fetchMock.mockImplementationOnce(async () => {
      switched.abort();
      return json(answer());
    });
    expect(await syncOfflineSnapshot('ws-a', switched.signal, deps)).toBe('stopped');
    expect(await kept()).toBeNull();
  });

  it('signing out while the answer is on its way: the list stays deleted', async () => {
    await keep({ ...answer(), savedAt: NOW - OFFLINE_FRESH_MS });
    let release: () => void = () => {};
    fetchMock.mockImplementationOnce((_url: string, init: RequestInit) => new Promise<Response>((resolve, reject) => {
      release = () => resolve(json(answer()));
      init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }));
    const saving = syncOfflineSnapshot('ws-a', live(), deps);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await clearOfflineSnapshot(store);
    release();
    expect(await saving).toBe('stopped');
    expect(await kept()).toBeNull();
  });

  it('signing out while a save still reads the device: it never writes', async () => {
    let releaseRead: () => void = () => {};
    const slowRead: OfflineStore = { ...store, read: () => new Promise((resolve) => (releaseRead = () => resolve(store.read()))) };
    const saving = syncOfflineSnapshot('ws-a', live(), { ...deps, store: slowRead });
    await clearOfflineSnapshot(store);
    releaseRead();
    expect(await saving).toBe('stopped');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await kept()).toBeNull();
  });

  it('no save starts in this tab after signing out', async () => {
    await clearOfflineSnapshot(store);
    expect(await syncOfflineSnapshot('ws-a', live(), deps)).toBe('stopped');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await kept()).toBeNull();
  });

  it('signing out in another tab while this one saves: the save does not write the list back', async () => {
    const otherTab = openOfflineStore(factory);
    fetchMock.mockImplementationOnce(async () => {
      await otherTab.clear();
      return json(answer());
    });
    expect(await syncOfflineSnapshot('ws-a', live(), deps)).toBe('stopped');
    expect(await kept()).toBeNull();
  });
});
