import { makeAutoObservable, observable } from 'mobx';
import type { MealBatchKind } from '@/lib/meals/batch';
import type { MealRecord } from '@/lib/meals/types';
import type { Refusal } from './ChecksOutbox';
import type { MealsStore } from './MealsStore';

/** A list action on screen whose answer from the server is still out. */
export interface MealWrite {
  id: number;
  kind: MealBatchKind;
  rowIds: string[];
}

/** What the server last confirmed about a receipt, and when: null when it is gone. */
export interface ConfirmedRecord {
  record: MealRecord | null;
  at: number;
}

/**
 * What outlives a visit of the meals page, the meal counterpart of the
 * `ChecksOutbox`. A person can leave while an answer is out and come back before
 * it arrives: the writes stay here, so a new `MealsStore` starts with them, and a
 * refusal stays here until it is closed, so it reaches the person wherever they
 * went by then. One per company, on the `AppStore`.
 */
export class MealsOutbox {
  /** On their way, oldest first. */
  writes: MealWrite[] = [];
  private lastWrite = 0;
  /** Per receipt, the newest thing the server confirmed: an older answer comes too late, and a read from before it is corrected by it. */
  confirmed = new Map<string, ConfirmedRecord>();
  refusals = observable.map<string, Refusal & { rowIds: string[] }>([], { deep: false });
  /** Counts the writes that ended: the navigation asks the server again when one ends with the page closed. */
  settled = 0;
  /** The store of the open page: a write begun on an earlier visit ends there too. */
  open: MealsStore | null = null;

  constructor() {
    makeAutoObservable<MealsOutbox, 'lastWrite'>(this, { writes: false, lastWrite: false, confirmed: false, refusals: false, open: false }, { autoBind: true });
  }

  /** Acting on a receipt again takes what was said about it away. */
  begin(kind: MealBatchKind, rowIds: string[]): MealWrite {
    for (const [key, { rowIds: about }] of this.refusals) if (about.some((id) => rowIds.includes(id))) this.refusals.delete(key);
    const write = { id: ++this.lastWrite, kind, rowIds };
    this.writes.push(write);
    return write;
  }

  end(write: MealWrite): void {
    this.writes = this.writes.filter((w) => w !== write);
    this.settled += 1;
  }

  /** False when the server already confirmed something newer about this receipt: this answer comes too late. */
  confirm(rowId: string, record: MealRecord | null, at: number): boolean {
    const last = this.confirmed.get(rowId);
    if (last && last.at > at) return false;
    this.confirmed.set(rowId, { record, at });
    return true;
  }

  say(write: MealWrite, who: string | null, message: string): void {
    const key = `meals:${write.id}`;
    this.refusals.set(key, { key, who, message, rowIds: write.rowIds });
  }

  /** Read and closed. Nothing but this and acting on the receipt again takes a refusal away. */
  clear(key: string): void {
    this.refusals.delete(key);
  }
}
