import { makeAutoObservable, observable } from 'mobx';
import { WORKSPACE_CHECKS, openQueue, waitingCounts } from '@/app/app/finance/tabs';
import type { TabKey } from '@/app/app/finance/tabs';
import type { BankView } from '@/app/app/finance/bank-actions';
import type { OwnNamesView } from '@/app/app/finance/own-names-actions';
import type { SharingView } from '@/app/app/finance/sharing-actions';
import type { AssetView, StatementItem, StatementView } from '@/lib/tax/service';
import { reuse } from './reuse';

export interface FinanceSeed {
  statement: StatementView;
  bank: BankView | null;
  sharing: SharingView | null;
  ownNames: OwnNamesView | null;
}

/** The newer of two reads. A read that could not get its data keeps what is there. */
const newer = <T extends { readAt: number }>(held: T | null, next: T | null): T | null => (next && (!held || next.readAt >= held.readAt) ? next : held);

/**
 * Finance on the client, for one visit: the one copy of what the server sent. Every
 * tab reads the same statement, so a change shows in all of them. The figures in
 * it are the server's and are never worked out here: a write waits for the whole
 * year it answers with, and nothing is shown before that.
 *
 * The statements are kept by year, so an answer has a place to land whichever year
 * is open by then, and going there and back finds it. Unchanged parts of a new
 * statement stay the same objects (`reuse`), so a row can tell by its record whether
 * it has to redraw. A read older than the statement held changes nothing.
 *
 * `behind` is the promise to a person told a write finished: a write can reach into
 * other years, so a statement read before it is not to be believed, and the page
 * reads that year again. The bank, the sharing and the names belong to the company,
 * not to a year, and each says itself when it was read.
 */
export class FinanceStore {
  year: number;
  private byYear = observable.map<number, StatementView>([], { deep: false });
  /** When the newest statement that answered a write was read. */
  writtenAt = 0;
  bank: BankView | null;
  sharing: SharingView | null;
  ownNames: OwnNamesView | null;

  constructor(seed: FinanceSeed) {
    this.year = seed.statement.year;
    this.byYear.set(seed.statement.year, seed.statement);
    this.bank = seed.bank;
    this.sharing = seed.sharing;
    this.ownNames = seed.ownNames;
    makeAutoObservable<FinanceStore, 'byYear'>(this, { byYear: false, bank: observable.ref, sharing: observable.ref, ownNames: observable.ref }, { autoBind: true });
  }

  get statement(): StatementView {
    return this.byYear.get(this.year) as StatementView;
  }

  /** Is the year on screen older than a write the person was told finished? */
  get behind(): boolean {
    return this.statement.readAt < this.writtenAt;
  }

  /** What the queue holds: the count of it is one number on the page, however many places show it. */
  get queue(): StatementItem[] {
    return openQueue(this.statement);
  }

  get counts(): Partial<Record<TabKey, number>> {
    return waitingCounts(this.statement, this.queue.length);
  }

  get itemsById(): Map<string, StatementItem> {
    return new Map(this.statement.items.map((i) => [i.itemId, i]));
  }

  get assetsById(): Map<string, AssetView> {
    return new Map(this.statement.assets.map((a) => [a.id, a]));
  }

  get openAssets(): number {
    return this.statement.assets.filter((a) => a.checks.length > 0).length;
  }

  /** Receipts counted on a guessed amount. */
  get estimated(): number {
    return this.statement.items.filter((i) => i.checks.some((c) => c.kind === 'amount_estimated')).length;
  }

  /** Receipts waiting on a setting of the whole company. */
  get blockedBySetting(): number {
    return this.statement.items.filter((i) => i.checks.some((c) => WORKSPACE_CHECKS.includes(c.kind))).length;
  }

  took(view: StatementView): void {
    const held = this.byYear.get(view.year);
    if (!held) this.byYear.set(view.year, view);
    else if (view.readAt >= held.readAt) this.byYear.set(view.year, reuse(held, view));
  }

  /** A write finished, and this is the year it answered with. */
  answered(view: StatementView): void {
    this.took(view);
    this.writtenAt = Math.max(this.writtenAt, view.readAt);
  }

  /** The server sent the page, of this year or another. */
  pageRead(seed: FinanceSeed): void {
    this.took(seed.statement);
    this.year = seed.statement.year;
    this.bankChanged(seed.bank);
    this.sharingChanged(seed.sharing);
    this.bookNames(seed.ownNames);
  }

  bankChanged(bank: BankView | null): void {
    this.bank = newer(this.bank, bank);
  }

  sharingChanged(sharing: SharingView | null): void {
    this.sharing = newer(this.sharing, sharing);
  }

  namesChanged(names: string[], readAt: number): void {
    if (this.ownNames) this.bookNames({ ...this.ownNames, names, readAt });
  }

  private bookNames(ownNames: OwnNamesView | null): void {
    this.ownNames = newer(this.ownNames, ownNames);
  }
}
