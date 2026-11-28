import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { openOfflineStore, type OfflineReceiptsResponse, type OfflineStore } from '../receipts-db';
import { OFFLINE_FRESH_MS, clearOfflineSnapshot, syncOfflineSnapshot, type SyncDeps } from '../sync';

const NOW = Date.UTC(2026, 10, 28, 10);
const receipt = { id: 'r1', date: '2026-11-02', name: 'Coop', vendor: null, gross: 12.5, currency: 'EUR', eur: 12.5, category: null, status: 'Offen', assignment: null };
const answer = (workspaceId = 'ws-a'): OfflineReceiptsResponse => ({ workspaceId, company: 'Firma A', receipts: [receipt] });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

let store: OfflineStore;
let fetchMock: ReturnType<typeof vi.fn>;
let deps: SyncDeps;

beforeEach(() => {
  store = openOfflineStore(new IDBFactory());
  fetchMock = vi.fn(async () => json(answer()));
  deps = { store, fetch: fetchMock as unknown as typeof fetch, now: () => NOW };
});

const live = () => new AbortController().signal;

describe('syncOfflineSnapshot', () => {
  it('saves the list when none is kept, and not again while it is younger than an hour', async () => {
    expect(await syncOfflineSnapshot('ws-a', live(), deps)).toBe('saved');
    expect(await store.read()).toEqual({ ...answer(), savedAt: NOW });
    expect(await syncOfflineSnapshot('ws-a', live(), { ...deps, now: () => NOW + OFFLINE_FRESH_MS - 1 })).toBe('fresh');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await syncOfflineSnapshot('ws-a', live(), { ...deps, now: () => NOW + OFFLINE_FRESH_MS })).toBe('saved');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('replaces a fresh list of another company', async () => {
    await store.write({ ...answer('ws-b'), savedAt: NOW });
    expect(await syncOfflineSnapshot('ws-a', live(), deps)).toBe('saved');
    expect((await store.read())?.workspaceId).toBe('ws-a');
  });

  it('deletes the list when the server no longer knows the session (401 and 403)', async () => {
    for (const status of [401, 403]) {
      await store.write({ ...answer('ws-b'), savedAt: NOW });
      fetchMock.mockResolvedValueOnce(json({ error: 'unauthorized' }, status));
      expect(await syncOfflineSnapshot('ws-a', live(), deps)).toBe('signed-out');
      expect(await store.read()).toBeNull();
    }
  });

  it('keeps the list on a server error, a broken answer or no connection', async () => {
    const kept = { ...answer('ws-b'), savedAt: NOW };
    await store.write(kept);
    fetchMock.mockResolvedValueOnce(json({ error: 'read_failed' }, 500));
    expect(await syncOfflineSnapshot('ws-a', live(), deps)).toBe('failed');
    fetchMock.mockResolvedValueOnce(new Response('<html>', { status: 200 }));
    expect(await syncOfflineSnapshot('ws-a', live(), deps)).toBe('failed');
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    expect(await syncOfflineSnapshot('ws-a', live(), deps)).toBe('failed');
    expect(await store.read()).toEqual(kept);
  });

  it('never writes an answer for another company than the one asked for', async () => {
    fetchMock.mockResolvedValueOnce(json(answer('ws-b')));
    expect(await syncOfflineSnapshot('ws-a', live(), deps)).toBe('failed');
    expect(await store.read()).toBeNull();
  });

  it('a company switch while the answer is on its way: the answer is not written', async () => {
    const switched = new AbortController();
    fetchMock.mockImplementationOnce(async () => {
      switched.abort();
      return json(answer());
    });
    expect(await syncOfflineSnapshot('ws-a', switched.signal, deps)).toBe('stopped');
    expect(await store.read()).toBeNull();
  });

  it('signing out while the answer is on its way: the list stays deleted', async () => {
    await store.write({ ...answer(), savedAt: NOW - OFFLINE_FRESH_MS });
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
    expect(await store.read()).toBeNull();
  });

  it('signing out after the answer arrived but before it was written: the delete runs last', async () => {
    let wanted = 0;
    const slowStore: OfflineStore = {
      ...store,
      write: (snapshot, stillWanted) => store.write(snapshot, () => {
        wanted += 1;
        return stillWanted ? stillWanted() : true;
      }),
    };
    const saving = syncOfflineSnapshot('ws-a', live(), { ...deps, store: slowStore });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await Promise.all([saving, clearOfflineSnapshot(store)]);
    expect(wanted).toBe(1);
    expect(await store.read()).toBeNull();
  });
});
