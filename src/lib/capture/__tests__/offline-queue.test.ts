import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { UploadStepError } from '@/lib/upload/errors';
import type { PipelineOutcome } from '@/lib/upload/pipeline';
import { SENT_NOT_CLEARED, drainQueue, singleFlight } from '../drain';
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
    expect(await store.list()).toMatchObject([{ id: 'sw-1', source: 'share', attempts: 0, lastError: null, sentAt: null }]);
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
    expect(await store.list()).toMatchObject([{ name: 'kaputt.jpg', attempts: 1, lastError: 'Upload request failed', sentAt: null }]);
  });
});

/**
 * Sending and removing are two steps. These tests break the second one: the
 * server has the photo, the browser cannot drop the queue entry. Whatever
 * happens then, the photo must not go to the server a second time.
 */
describe('drainQueue: the server has the photo but the entry cannot be removed', () => {
  async function seed(...names: string[]) {
    for (const [i, name] of names.entries()) await store.add(newQueuedCapture(photo(name), 'camera', i + 1));
  }
  /** The real store with `remove` failing the first `times` calls. */
  function failingRemove(times: number): CaptureStore {
    let left = times;
    return {
      ...store,
      remove: async (id) => {
        if (left > 0) {
          left -= 1;
          throw new Error('QuotaExceededError');
        }
        await store.remove(id);
      },
    };
  }

  it('forward: counted as sent, reported as stuck, never as a failed send, and marked in the queue', async () => {
    await seed('a.jpg');
    const send = vi.fn<(file: File) => Promise<PipelineOutcome>>(async () => DONE);
    const result = await drainQueue(failingRemove(1), send, { now: () => 5000 });
    expect(send).toHaveBeenCalledTimes(1);
    expect(result.sent).toHaveLength(1);
    expect(result).toMatchObject({ failed: 0, stuck: 1, cleared: 0, remaining: 1, stopped: null });
    expect(await store.list()).toMatchObject([{ name: 'a.jpg', sentAt: 5000, lastError: SENT_NOT_CLEARED, attempts: 0 }]);
  });

  it('the next run does NOT send it again; it only removes the entry', async () => {
    await seed('a.jpg');
    const broken = failingRemove(1);
    const send = vi.fn<(file: File) => Promise<PipelineOutcome>>(async () => DONE);
    await drainQueue(broken, send);
    const second = await drainQueue(broken, send);
    expect(send).toHaveBeenCalledTimes(1);
    expect(second).toMatchObject({ failed: 0, stuck: 0, cleared: 1, remaining: 0 });
    expect(second.sent).toEqual([]);
    expect(await store.list()).toEqual([]);
  });

  it('a removal that keeps failing never causes a second upload, run after run, and keeps its first sent time', async () => {
    await seed('a.jpg');
    const broken = failingRemove(3);
    const send = vi.fn<(file: File) => Promise<PipelineOutcome>>(async () => DONE);
    await drainQueue(broken, send, { now: () => 5000 });
    expect(await drainQueue(broken, send, { now: () => 6000 })).toMatchObject({ stuck: 1, cleared: 0, remaining: 1 });
    expect(await drainQueue(broken, send, { now: () => 7000 })).toMatchObject({ stuck: 1, cleared: 0, remaining: 1 });
    expect(send).toHaveBeenCalledTimes(1);
    expect(await store.list()).toMatchObject([{ sentAt: 5000 }]);
    // Re-entry after it finally clears: nothing is left and nothing is sent.
    expect(await drainQueue(broken, send)).toMatchObject({ cleared: 1, remaining: 0 });
    expect(await drainQueue(broken, send)).toMatchObject({ cleared: 0, stuck: 0, remaining: 0 });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('resume after a reload: a fresh store on the same database sees the mark and does not send', async () => {
    await seed('a.jpg');
    await drainQueue(failingRemove(1), async () => DONE);
    const reopened = openCaptureStore(factory);
    const send = vi.fn<(file: File) => Promise<PipelineOutcome>>(async () => DONE);
    const result = await drainQueue(reopened, send);
    expect(send).not.toHaveBeenCalled();
    expect(result).toMatchObject({ cleared: 1, remaining: 0 });
  });

  it('a later photo is sent once while the stuck one is left alone (changed input)', async () => {
    await seed('a.jpg');
    const broken = failingRemove(2);
    const send = vi.fn<(file: File) => Promise<PipelineOutcome>>(async () => DONE);
    await drainQueue(broken, send);
    await store.add(newQueuedCapture(photo('b.jpg'), 'camera', 99));
    const second = await drainQueue(broken, send);
    expect(send.mock.calls.map((c) => c[0].name)).toEqual(['a.jpg', 'b.jpg']);
    expect(second.sent.map((s) => s.entry.name)).toEqual(['b.jpg']);
    expect(second).toMatchObject({ stuck: 1, remaining: 1 });
    expect((await store.list()).map((e) => e.name)).toEqual(['a.jpg']);
  });

  it('a stuck entry is cleared without a connection, and does not hide the photos that still wait', async () => {
    await seed('a.jpg', 'b.jpg');
    const broken = failingRemove(1);
    const first = vi.fn().mockResolvedValueOnce(DONE).mockRejectedValueOnce(new UploadStepError('network', 'Upload network error'));
    expect(await drainQueue(broken, first)).toMatchObject({ stuck: 1, stopped: 'offline', remaining: 2 });
    const offline = vi.fn<(file: File) => Promise<PipelineOutcome>>(async () => DONE);
    const result = await drainQueue(broken, offline, { isOnline: () => false });
    expect(offline).not.toHaveBeenCalled();
    expect(result).toMatchObject({ cleared: 1, stopped: 'offline', remaining: 1 });
    expect((await store.list()).map((e) => e.name)).toEqual(['b.jpg']);
  });

  it('a store that can neither remove nor mark: the open page still does not send the photo again', async () => {
    await seed('a.jpg');
    const dead: CaptureStore = {
      ...store,
      remove: async () => { throw new Error('storage is gone'); },
      update: async () => { throw new Error('storage is gone'); },
    };
    const send = vi.fn<(file: File) => Promise<PipelineOutcome>>(async () => DONE);
    expect(await drainQueue(dead, send)).toMatchObject({ stuck: 1, failed: 0 });
    expect(await drainQueue(dead, send)).toMatchObject({ stuck: 1, failed: 0 });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('a send that fails is not marked as sent and is tried again', async () => {
    await seed('a.jpg');
    const send = vi.fn().mockRejectedValueOnce(new UploadStepError('server', 'Upload request failed')).mockResolvedValueOnce(DONE);
    expect(await drainQueue(store, send)).toMatchObject({ failed: 1, stuck: 0, remaining: 1 });
    expect(await store.list()).toMatchObject([{ sentAt: null, attempts: 1 }]);
    expect(await drainQueue(store, send)).toMatchObject({ failed: 0, remaining: 0 });
    expect(send).toHaveBeenCalledTimes(2);
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
