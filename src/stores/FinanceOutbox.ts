import { makeAutoObservable, observable } from 'mobx';
import type { Refusal } from './ChecksOutbox';

/**
 * The refusals of finance writes that came after the page closed, the finance
 * counterpart of the `MealsOutbox`. Finance shows nothing as done before the
 * server answers, so no number is wrong and there are no writes to keep, but a
 * person who pressed a button and went elsewhere believes it went through: the
 * refusal stays here until it is closed, and the shell says it (`Refusals`).
 * One per company, on the `AppStore`.
 */
export class FinanceOutbox {
  private last = 0;
  refusals = observable.map<string, Refusal>([], { deep: false });
  /** Set once the company is left: what is refused from then on goes here. */
  private leftTo: ((refusal: Refusal) => void) | null = null;

  constructor() {
    makeAutoObservable<FinanceOutbox, 'last' | 'leftTo'>(this, { last: false, refusals: false, leftTo: false }, { autoBind: true });
  }

  say(who: string | null, message: string): void {
    const refusal = { key: `finance:${++this.last}`, who, message };
    if (this.leftTo) this.leftTo(refusal);
    else this.refusals.set(refusal.key, refusal);
  }

  /** The company left the screen: what stands here goes along, and what comes later follows. */
  leave(send: (refusal: Refusal) => void): void {
    this.leftTo = send;
    for (const refusal of this.refusals.values()) send(refusal);
    this.refusals.clear();
  }

  stay(): void {
    this.leftTo = null;
  }

  /** Read and closed. */
  clear(key: string): void {
    this.refusals.delete(key);
  }
}
