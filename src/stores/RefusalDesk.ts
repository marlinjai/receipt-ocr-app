import { makeAutoObservable, observable } from 'mobx';
import type { Refusal } from './ChecksOutbox';

/** A refusal of a company the person has left. */
export interface AwayRefusal {
  key: string;
  company: string;
  who: string | null;
  message: string;
}

/**
 * Where a refusal goes when its company is no longer on screen. The `AppStore` is
 * thrown away on a company switch, so that nothing of one company stays in
 * another, but a person who believes a change went through must still be told.
 * This sits above the provider the company keys and holds nothing but such
 * refusals, each with its company, so none can read as the one on screen's. It
 * stays until it is closed.
 */
export class RefusalDesk {
  private last = 0;
  refusals = observable.map<string, AwayRefusal>([], { deep: false });

  constructor() {
    makeAutoObservable<RefusalDesk, 'last'>(this, { last: false, refusals: false }, { autoBind: true });
  }

  take(company: string, { who, message }: Refusal): void {
    const key = `away:${++this.last}`;
    this.refusals.set(key, { key, company, who, message });
  }

  close(key: string): void {
    this.refusals.delete(key);
  }
}
