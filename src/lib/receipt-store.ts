import type { FileInfo } from '@/lib/storage';
import type { OcrResult } from '@/lib/ocr-types';

export interface PendingReceipt {
  file: FileInfo;
  ocrResult: OcrResult | null;
}

type Listener = (receipt: PendingReceipt) => void;

const listeners = new Set<Listener>();
const pendingReceipts: PendingReceipt[] = [];

export const receiptStore = {
  addReceipt(receipt: PendingReceipt) {
    pendingReceipts.push(receipt);
    listeners.forEach((fn) => fn(receipt));
  },

  consumePending(): PendingReceipt[] {
    return pendingReceipts.splice(0);
  },

  subscribe(fn: Listener): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};
