import type { FileInfo } from '@/lib/storage';

type Listener = (receipt: FileInfo) => void;

const listeners = new Set<Listener>();
const pendingReceipts: FileInfo[] = [];

export const receiptStore = {
  addReceipt(receipt: FileInfo) {
    pendingReceipts.push(receipt);
    listeners.forEach((fn) => fn(receipt));
  },

  consumePending(): FileInfo[] {
    return pendingReceipts.splice(0);
  },

  subscribe(fn: Listener): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};
