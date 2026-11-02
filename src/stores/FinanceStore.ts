import { makeAutoObservable, observable } from 'mobx';
import { WORKSPACE_CHECKS, openQueue, waitingCounts } from '@/app/app/finance/tabs';
import type { TabKey } from '@/app/app/finance/tabs';
import type { BankView } from '@/app/app/finance/bank-actions';
import type { SharingView } from '@/app/app/finance/sharing-actions';
import type { AssetView, StatementItem, StatementView } from '@/lib/tax/service';
import { reuse } from './reuse';

export interface FinanceSeed {
  statement: StatementView;
  bank: BankView | null;
  sharing: SharingView | null;
}

/**
 * One year of finance on the client, for one visit: the one copy of what the
 * server sent. Every tab reads the same statement, so a change shows in all of
 * them. The figures in it are the server's and are never worked out here: a write
 * waits for the whole year it answers with, and nothing is shown before that.
 *
 * Unchanged parts of a new statement stay the same objects (`reuse`), so a row can
 * tell by its record whether it has to redraw. A statement of another year, or one
 * read before the one on screen, changes nothing: it came too late.
 */
export class FinanceStore {
  statement: StatementView;
  bank: BankView | null;
  sharing: SharingView | null;

  constructor(seed: FinanceSeed) {
    this.statement = seed.statement;
    this.bank = seed.bank;
    this.sharing = seed.sharing;
    makeAutoObservable(this, { statement: observable.ref, bank: observable.ref, sharing: observable.ref }, { autoBind: true });
  }

  get year(): number {
    return this.statement.year;
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
    if (view.year !== this.year || view.readAt < this.statement.readAt) return;
    this.statement = reuse(this.statement, view);
  }

  bankChanged(bank: BankView): void {
    this.bank = bank;
  }

  sharingChanged(sharing: SharingView): void {
    this.sharing = sharing;
  }
}
