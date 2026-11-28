/**
 * The receipts list kept on this device for the offline page (plan
 * docs/plans/2026-11-28-offline-receipts.md). The app writes it, `public/offline.html`
 * reads it without any app script. The four names below must match that page (a test
 * compares them).
 *
 * One list at a time: the company last open on this device. Signing out, or the server
 * saying the session is gone, deletes it, because the offline page is a public file that
 * anyone using this browser can open.
 */

export const OFFLINE_DB_NAME = 'receipts-offline';
export const OFFLINE_DB_VERSION = 1;
export const OFFLINE_STORE_NAME = 'snapshot';
export const OFFLINE_KEY = 'current';

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
  read(): Promise<OfflineSnapshot | null>;
  /** Saves the list unless `stillWanted` says no at the moment the write is placed. Returns whether it was saved. */
  write(snapshot: OfflineSnapshot, stillWanted?: () => boolean): Promise<boolean>;
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

/** The list backed by IndexedDB. Each method rejects when the browser has no usable IndexedDB. */
export function openOfflineStore(factory: IDBFactory = indexedDB): OfflineStore {
  return {
    async read() {
      const db = await openDatabase(factory);
      try {
        const tx = db.transaction(OFFLINE_STORE_NAME, 'readonly');
        const request = tx.objectStore(OFFLINE_STORE_NAME).get(OFFLINE_KEY);
        await settle(tx);
        return isSnapshot(request.result) ? request.result : null;
      } finally {
        db.close();
      }
    },
    async write(snapshot, stillWanted = () => true) {
      const db = await openDatabase(factory);
      try {
        // Checked when the transaction is placed: IndexedDB runs transactions on one store in the
        // order they were created, so a `clear` placed after this check always runs after this write.
        if (!stillWanted()) return false;
        const tx = db.transaction(OFFLINE_STORE_NAME, 'readwrite');
        tx.objectStore(OFFLINE_STORE_NAME).put(snapshot, OFFLINE_KEY);
        await settle(tx);
        return true;
      } finally {
        db.close();
      }
    },
    async clear() {
      // The store is emptied, not the database deleted: a delete waits behind every open connection (another tab).
      const db = await openDatabase(factory);
      try {
        const tx = db.transaction(OFFLINE_STORE_NAME, 'readwrite');
        tx.objectStore(OFFLINE_STORE_NAME).clear();
        await settle(tx);
      } finally {
        db.close();
      }
    },
  };
}
