/**
 * The receipts list kept on this device for the offline page (plan
 * docs/plans/2026-11-28-offline-receipts.md). The app writes it, `public/offline.html`
 * reads it without any app script, and the service worker deletes it when the session is gone.
 * The names below must match those two files (a test compares them).
 *
 * One list at a time: the company last open on this device. Signing out, or the server
 * saying the session is gone, deletes it, because the offline page is a public file that
 * anyone using this browser can open.
 */

export const OFFLINE_DB_NAME = 'receipts-offline';
export const OFFLINE_DB_VERSION = 1;
export const OFFLINE_STORE_NAME = 'snapshot';
export const OFFLINE_KEY = 'current';
/**
 * How often the list was deleted on this device, kept beside it. A save reads it when it starts and
 * writes only if it is unchanged: a sign-out in any tab while the save was on its way wins, without
 * comparing clocks.
 */
export const OFFLINE_DELETIONS_KEY = 'deletions';
const DELETIONS_KEY = OFFLINE_DELETIONS_KEY;
/**
 * The offline page shows no list older than this. The session's end is not known on the device (a
 * session ended while the app was closed deletes nothing), so the list lasts a week after the app
 * was last open online: enough for a trip without a connection, short for a device left behind.
 */
export const OFFLINE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** One receipt as the offline page shows it. Labels, never option ids; null where the receipt has no value. */
export interface OfflineReceipt {
  id: string;
  /** `YYYY-MM-DD`. */
  date: string | null;
  name: string | null;
  vendor: string | null;
  gross: number | null;
  currency: string | null;
  /** The amount in euro (gross times exchange rate). */
  eur: number | null;
  category: string | null;
  status: string | null;
  assignment: string | null;
}

/** What `GET /api/receipts/offline` answers. */
export interface OfflineReceiptsResponse {
  workspaceId: string;
  company: string;
  receipts: OfflineReceipt[];
}

export interface OfflineSnapshot extends OfflineReceiptsResponse {
  /** When the list was saved on this device (epoch milliseconds). */
  savedAt: number;
}

export interface OfflineStore {
  /** The list kept, and how often a list was deleted here so far (hand it to `write`). */
  read(): Promise<{ snapshot: OfflineSnapshot | null; deletions: number }>;
  /**
   * Saves the list, unless it was deleted since `deletions` was read (a sign-out, in any tab) or
   * `stillWanted` says no when the write is placed. Returns whether it was saved.
   */
  write(snapshot: OfflineSnapshot, deletions: number, stillWanted?: () => boolean): Promise<boolean>;
  /** Deletes the list and counts the deletion, so a save that started before it never writes. */
  clear(): Promise<void>;
}

function openDatabase(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const open = factory.open(OFFLINE_DB_NAME, OFFLINE_DB_VERSION);
    open.onupgradeneeded = () => {
      if (!open.result.objectStoreNames.contains(OFFLINE_STORE_NAME)) open.result.createObjectStore(OFFLINE_STORE_NAME);
    };
    open.onerror = () => reject(open.error ?? new Error('IndexedDB open failed'));
    open.onsuccess = () => resolve(open.result);
  });
}

function settle(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

function isSnapshot(value: unknown): value is OfflineSnapshot {
  const v = value as OfflineSnapshot | null;
  return !!v && typeof v.workspaceId === 'string' && typeof v.savedAt === 'number' && Array.isArray(v.receipts);
}

const count = (value: unknown): number => (typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0);

/** The list backed by IndexedDB. Each method rejects when the browser has no usable IndexedDB. */
export function openOfflineStore(factory: IDBFactory = indexedDB): OfflineStore {
  return {
    async read() {
      const db = await openDatabase(factory);
      try {
        const tx = db.transaction(OFFLINE_STORE_NAME, 'readonly');
        const store = tx.objectStore(OFFLINE_STORE_NAME);
        const list = store.get(OFFLINE_KEY);
        const deleted = store.get(DELETIONS_KEY);
        await settle(tx);
        return { snapshot: isSnapshot(list.result) ? list.result : null, deletions: count(deleted.result) };
      } finally {
        db.close();
      }
    },
    async write(snapshot, deletions, stillWanted = () => true) {
      const db = await openDatabase(factory);
      try {
        if (!stillWanted()) return false;
        // One transaction reads the count and writes the list: IndexedDB runs transactions on one store
        // one after another, so a deletion is either fully before this (the count differs) or after it.
        const tx = db.transaction(OFFLINE_STORE_NAME, 'readwrite');
        const store = tx.objectStore(OFFLINE_STORE_NAME);
        let saved = false;
        const current = store.get(DELETIONS_KEY);
        current.onsuccess = () => {
          if (count(current.result) !== deletions) return;
          store.put(snapshot, OFFLINE_KEY);
          saved = true;
        };
        await settle(tx);
        return saved;
      } finally {
        db.close();
      }
    },
    async clear() {
      // The key is deleted, not the database: a database delete waits behind every open connection (another tab).
      const db = await openDatabase(factory);
      try {
        const tx = db.transaction(OFFLINE_STORE_NAME, 'readwrite');
        const store = tx.objectStore(OFFLINE_STORE_NAME);
        const current = store.get(DELETIONS_KEY);
        current.onsuccess = () => {
          store.delete(OFFLINE_KEY);
          store.put(count(current.result) + 1, DELETIONS_KEY);
        };
        await settle(tx);
      } finally {
        db.close();
      }
    },
  };
}
