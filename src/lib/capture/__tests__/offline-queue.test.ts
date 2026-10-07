import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { UploadStepError } from '@/lib/upload/errors';
import type { PipelineOutcome } from '@/lib/upload/pipeline';
import { drainQueue, singleFlight } from '../drain';
import { newQueuedCapture, openCaptureStore, queuedFile, type CaptureStore } from '../offline-queue';

const DONE: PipelineOutcome = {
  kind: 'done', rowId: 'row-1', similar: null, category: 'Bewirtung', isMeal: true, attention: null, ocrError: null,
};

let factory: IDBFactory;
let store: CaptureStore;

function photo(name: string) {
  return new File([new Uint8Array([1, 2, 3])], name, { type: 'image/jpeg' });
}

beforeEach(() => {
  factory = new IDBFactory();
  store = openCaptureStore(factory);
});

describe('capture queue (IndexedDB)', () => {
  it('keeps photos across a "reload" (a fresh store on the same database), oldest first', async () => {
    await store.add(newQueuedCapture(photo('zweites.jpg'), 'camera', 2000));
    await store.add(newQueuedCapture(photo('erstes.jpg'), 'camera', 1000));
    const reopened = openCaptureStore(factory);
    const list = await reopened.list();
    expect(list.map((e) => e.name)).toEqual(['erstes.jpg', 'zweites.jpg']);
    expect(list[0]).toMatchObject({ source: 'camera', attempts: 0, lastError: null, type: 'image/jpeg' });
    const file = queuedFile(list[0]);
    expect(file.name).toBe('erstes.jpg');
    expect(file.size).toBe(3);
  });

  it('removes and updates single entries', async () => {
    const a = newQueuedCapture(photo('a.jpg'), 'camera', 1);
    const b = newQueuedCapture(photo('b.jpg'), 'share', 2);
    await store.add(a);
    await store.add(b);
    await store.update(b.id, { attempts: 2, lastError: 'OCR failed (502)' });
    await store.remove(a.id);
    expect(await store.list()).toMatchObject([{ id: b.id, attempts: 2, lastError: 'OCR failed (502)', source: 'share' }]);
    // Updating an entry that is gone is a no-op, not an error.
    await expect(store.update(a.id, { attempts: 9 })).resolves.toBeUndefined();
  });

  it('reads entries written by the service worker or the offline page (no attempts or error fields)', async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = factory.open('receipt-capture', 1);
      open.onupgradeneeded = () => open.result.createObjectStore('queue', { keyPath: 'id' });
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    await new Promise<void>((resolve) => {
      const tx = db.transaction('queue', 'readwrite');
      tx.objectStore('queue').put({ id: 'sw-1', name: 'geteilt.pdf', type: 'application/pdf', blob: new Blob(['x']), addedAt: 5, source: 'share' });
      tx.objectStore('queue').put({ id: 'broken', name: 'kein-blob' });
      tx.oncomplete = () => resolve();
    });
    db.close();
    expect(await store.list()).toMatchObject([{ id: 'sw-1', source: 'share', attempts: 0, lastError: null }]);
  });
});

describe('drainQueue', () => {
  async function seed(...names: string[]) {
    for (const [i, name] of names.entries()) await store.add(newQueuedCapture(photo(name), 'camera', i + 1));
  }

  it('sends everything oldest first and empties the queue', async () => {
    await seed('a.jpg', 'b.jpg', 'c.jpg');
    const send = vi.fn<(file: File) => Promise<PipelineOutcome>>(async () => DONE);
    const result = await drainQueue(store, send);
    expect(send.mock.calls.map((c) => c[0].name)).toEqual(['a.jpg', 'b.jpg', 'c.jpg']);
    expect(result).toMatchObject({ remaining: 0, stopped: null, failed: 0 });
    expect(result.sent).toHaveLength(3);
    expect(await store.list()).toEqual([]);
  });

  it('a second run sends nothing twice', async () => {
    await seed('a.jpg');
    const send = vi.fn(async () => DONE);
    await drainQueue(store, send);
    await drainQueue(store, send);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('a file that is already on the server leaves the queue without a second upload', async () => {
    await seed('a.jpg');
    const result = await drainQueue(store, async () => ({ kind: 'duplicate', existing: { rowId: 'r', name: 'Testlokal' } }));
    expect(result.sent[0].outcome.kind).toBe('duplicate');
    expect(result.remaining).toBe(0);
  });

  it('a lost connection stops the run and keeps the failed photo and everything behind it', async () => {
    await seed('a.jpg', 'b.jpg', 'c.jpg');
    const send = vi
      .fn()
      .mockResolvedValueOnce(DONE)
      .mockRejectedValueOnce(new UploadStepError('network', 'Upload network error'));
    const result = await drainQueue(store, send);
    expect(send).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ remaining: 2, stopped: 'offline' });
    expect((await store.list()).map((e) => e.name)).toEqual(['b.jpg', 'c.jpg']);
    // Later, with the connection back, the rest goes out exactly once.
    const retry = vi.fn<(file: File) => Promise<PipelineOutcome>>(async () => DONE);
    expect(await drainQueue(store, retry)).toMatchObject({ remaining: 0, stopped: null });
    expect(retry.mock.calls.map((c) => c[0].name)).toEqual(['b.jpg', 'c.jpg']);
  });

  it('a raw failed fetch (TypeError) counts as a lost connection too', async () => {
    await seed('a.jpg');
    const result = await drainQueue(store, async () => {
      throw new TypeError('Failed to fetch');
    });
    expect(result).toMatchObject({ remaining: 1, stopped: 'offline' });
  });

  it('does not even try while the browser reports offline', async () => {
    await seed('a.jpg');
    const send = vi.fn(async () => DONE);
    const result = await drainQueue(store, send, { isOnline: () => false });
    expect(send).not.toHaveBeenCalled();
    expect(result).toMatchObject({ remaining: 1, stopped: 'offline' });
  });

  it('an expired session stops the run and keeps every photo for after the login', async () => {
    await seed('a.jpg', 'b.jpg');
    const send = vi.fn().mockRejectedValue(new UploadStepError('auth', 'Your session has expired.'));
    const result = await drainQueue(store, send);
    expect(send).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ remaining: 2, stopped: 'auth' });
  });

  it('one bad file stays queued with its error and does not block the photos behind it', async () => {
    await seed('kaputt.jpg', 'gut.jpg');
    const send = vi
      .fn()
      .mockRejectedValueOnce(new UploadStepError('server', 'Upload request failed'))
      .mockResolvedValueOnce(DONE);
    const result = await drainQueue(store, send);
    expect(result).toMatchObject({ remaining: 1, stopped: null, failed: 1 });
    expect(await store.list()).toMatchObject([{ name: 'kaputt.jpg', attempts: 1, lastError: 'Upload request failed' }]);
  });
});

describe('singleFlight', () => {
  it('two triggers at once (online event plus page open) run one drain', async () => {
    let release!: () => void;
    const work = vi.fn(() => new Promise<string>((resolve) => { release = () => resolve('done'); }));
    const drain = singleFlight(work);
    const first = drain();
    const second = drain();
    release();
    expect(await first).toBe('done');
    expect(await second).toBe('done');
    expect(work).toHaveBeenCalledTimes(1);
    // After it finished, the next trigger starts a new run.
    const third = drain();
    release();
    await third;
    expect(work).toHaveBeenCalledTimes(2);
  });
});
