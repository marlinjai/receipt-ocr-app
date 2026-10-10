/**
 * Photos waiting to be sent, kept in the browser (IndexedDB) so a capture
 * survives being offline, a lost connection, an expired session, a reload or
 * the app being closed.
 *
 * THREE writers share this store and must agree on its shape: this module (the
 * app), the service worker `public/sw.js` (shared files) and the offline page
 * `public/offline.html` (photos taken without a connection). The names below
 * are repeated there as literals; a test compares them.
 *
 * `sentAt` is written by the app only (see drain.ts). The other two writers
 * leave it out, and `list()` reads a missing value as "not sent yet".
 */

export const CAPTURE_DB_NAME = 'receipt-capture';
export const CAPTURE_DB_VERSION = 1;
export const CAPTURE_STORE_NAME = 'queue';

export type CaptureSource = 'camera' | 'share' | 'offline-page';

export interface QueuedCapture {
  id: string;
  name: string;
  type: string;
  blob: Blob;
  /** Milliseconds since the epoch; the queue is sent oldest first. */
  addedAt: number;
  source: CaptureSource;
  attempts: number;
  lastError: string | null;
  /**
   * Set when the server has this photo but the entry could not be removed from
   * the queue. An entry with a value here is NEVER sent again; the next run
   * only tries to remove it. Null while the photo still waits to be sent.
   */
  sentAt: number | null;
}

export interface CaptureStore {
  add(entry: QueuedCapture): Promise<void>;
  /** Oldest first. */
  list(): Promise<QueuedCapture[]>;
  remove(id: string): Promise<void>;
  update(id: string, patch: Partial<Pick<QueuedCapture, 'attempts' | 'lastError' | 'sentAt'>>): Promise<void>;
}

function promisify<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

function openDatabase(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const open = factory.open(CAPTURE_DB_NAME, CAPTURE_DB_VERSION);
    open.onupgradeneeded = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains(CAPTURE_STORE_NAME)) {
        db.createObjectStore(CAPTURE_STORE_NAME, { keyPath: 'id' });
      }
    };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error ?? new Error('IndexedDB is not available'));
    open.onblocked = () => reject(new Error('IndexedDB is blocked by another tab'));
  });
}

/** The queue backed by IndexedDB. Throws (from each method) when the browser has no usable IndexedDB. */
export function openCaptureStore(factory: IDBFactory = indexedDB): CaptureStore {
  const run = async <T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
    const db = await openDatabase(factory);
    try {
      const tx = db.transaction(CAPTURE_STORE_NAME, mode);
      const result = await promisify(work(tx.objectStore(CAPTURE_STORE_NAME)));
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
        tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
      });
      return result;
    } finally {
      db.close();
    }
  };

  return {
    async add(entry) {
      await run('readwrite', (store) => store.put(entry));
    },
    async list() {
      const all = (await run('readonly', (store) => store.getAll())) as QueuedCapture[];
      return all
        .filter((e) => e && typeof e.id === 'string' && e.blob instanceof Blob)
        .map((e) => ({
          ...e,
          attempts: typeof e.attempts === 'number' ? e.attempts : 0,
          lastError: typeof e.lastError === 'string' ? e.lastError : null,
          sentAt: typeof e.sentAt === 'number' ? e.sentAt : null,
          source: e.source ?? 'camera',
        }))
        .sort((a, b) => a.addedAt - b.addedAt);
    },
    async remove(id) {
      await run('readwrite', (store) => store.delete(id));
    },
    async update(id, patch) {
      const db = await openDatabase(factory);
      try {
        const tx = db.transaction(CAPTURE_STORE_NAME, 'readwrite');
        const store = tx.objectStore(CAPTURE_STORE_NAME);
        const current = (await promisify(store.get(id))) as QueuedCapture | undefined;
        if (current) store.put({ ...current, ...patch });
        await new Promise<void>((resolve, reject) => {
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
          tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
        });
      } finally {
        db.close();
      }
    },
  };
}

export function newQueuedCapture(file: File | Blob, source: CaptureSource, now: number = Date.now()): QueuedCapture {
  const name = file instanceof File && file.name ? file.name : `foto-${now}.jpg`;
  return {
    id: `${now}-${Math.random().toString(36).slice(2, 10)}`,
    name,
    type: file.type || 'image/jpeg',
    blob: file,
    addedAt: now,
    source,
    attempts: 0,
    lastError: null,
    sentAt: null,
  };
}

export function queuedFile(entry: QueuedCapture): File {
  return new File([entry.blob], entry.name, { type: entry.type, lastModified: entry.addedAt });
}
