import { makeAutoObservable, observable } from 'mobx';
import type { BankView } from '@/app/app/finance/bank-actions';
import type { SharingView } from '@/app/app/finance/sharing-actions';
import type { StatementView } from '@/lib/tax/service';
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
