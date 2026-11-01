import { makeAutoObservable, observable } from 'mobx';
import type { CheckChange } from '@/app/app/spending/loop-actions';
import type { CheckEdit } from '@/app/app/spending/open-checks';
import type { ChecksStore } from './ChecksStore';

/** A change on screen whose answer from the server is still out. */
export interface LocalWrite {
  id: number;
  paymentId: string;
  edit: CheckEdit;
  /** The receipt it links: held back from the proposals of every other payment meanwhile. */
  rowId: string | null;
}

/** A change the server made. `state` is left out when a newer write on the same payment had its answer first. */
export type Confirmed = Omit<CheckChange, 'state'> & { state?: CheckChange['state'] };

/** Something the server refused, under the key of the place it belongs to (`checkKey`, `note:<id>`, or a word for the page as a whole). */
export interface Refusal {
  key: string;
  /** What it is about, for where it shows away from its row. */
  who: string | null;
  message: string;
}

export const checkKey = (paymentId: string) => `check:${paymentId}`;

/**
 * What outlives a visit of the receipt checks. A person can leave the panel while
 * an answer is out, and come back before it arrives: the writes stay here, so a
 * new `ChecksStore` starts with them, and a refusal stays here until it is
 * read, so it reaches the person wherever they went by then. One per company,
 * on the `AppStore`.
 */
export class ChecksOutbox {
  /** On their way, oldest first. */
  writes: LocalWrite[] = [];
  /** What the server confirmed and a read may not know yet. */
  confirmed: Confirmed[] = [];
  private lastWrite = 0;
  /** Per payment, the newest write the server has answered: an answer to an older one comes too late. */
  private answeredUpTo = new Map<string, number>();
  refusals = observable.map<string, Refusal>([], { deep: false });
  /** The store of the open panel: a write begun on an earlier visit ends there too. */
  open: ChecksStore | null = null;

  constructor() {
    makeAutoObservable<ChecksOutbox, 'lastWrite' | 'answeredUpTo'>(this, { writes: false, confirmed: false, lastWrite: false, answeredUpTo: false, refusals: false, open: false }, { autoBind: true });
  }

  begin(paymentId: string, edit: CheckEdit, rowId: string | null): LocalWrite {
    const write = { id: ++this.lastWrite, paymentId, edit, rowId };
    this.writes.push(write);
    return write;
  }

  confirm(write: LocalWrite, change: CheckChange): Confirmed {
    this.writes = this.writes.filter((w) => w !== write);
    // The answer to an older write coming after a newer one's says nothing about the payment any more. Its receipt is linked all the same.
    const late = (this.answeredUpTo.get(write.paymentId) ?? 0) > write.id;
    if (!late) this.answeredUpTo.set(write.paymentId, write.id);
    const confirmed: Confirmed = late ? { paymentId: change.paymentId, rowId: change.rowId, settled: change.settled, at: change.at } : change;
    this.confirmed.push(confirmed);
    return confirmed;
  }

  refuse(write: LocalWrite): void {
    this.writes = this.writes.filter((w) => w !== write);
  }

  /** A read that started at `readAt` knows everything confirmed before it. */
  forget(readAt: number): void {
    this.confirmed = this.confirmed.filter((c) => c.at >= readAt);
  }

  say(key: string, who: string | null, message: string): void {
    this.refusals.set(key, { key, who, message });
  }

  /** Acted on again, or read and closed. Nothing else takes a refusal away. */
  clear(key: string): void {
    this.refusals.delete(key);
  }
}
