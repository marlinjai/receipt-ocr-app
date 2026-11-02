import { computed, makeAutoObservable, observable } from 'mobx';
import type { NavCounts } from '@/app/app/nav-actions';
import { ChecksOutbox, type Refusal } from './ChecksOutbox';
import type { ChecksStore } from './ChecksStore';
import { MealsOutbox } from './MealsOutbox';
import type { MealsStore } from './MealsStore';
import type { ReceiptsStore } from './ReceiptsStore';

/**
 * What the whole app shares on the client, for one company: the store of each
 * domain whose page is open, and the numbers of the navigation. A number comes
 * from the domain's store while its page is open, so it follows every change by
 * itself; otherwise from what the server last said. Created per company (see
 * `AppStoreProvider`), so nothing of another company can stay on screen.
 *
 * Plan: docs/plans/2026-11-01-client-state.md.
 */
export class AppStore {
  meals: MealsStore | null = null;
  checks: ChecksStore | null = null;
  receipts: ReceiptsStore | null = null;
  /** The writes and refusals of the receipt checks: they outlive a visit of the panel. */
  readonly checkOutbox = new ChecksOutbox();
  /** The same for the list actions of the meals page. */
  readonly mealOutbox = new MealsOutbox();
  private fromServer: NavCounts | null = null;

  constructor() {
    makeAutoObservable<AppStore, 'fromServer'>(this, { meals: observable.ref, checks: observable.ref, receipts: observable.ref, checkOutbox: false, mealOutbox: false, fromServer: observable.ref, counts: computed.struct }, { autoBind: true });
  }

  get counts(): NavCounts | null {
    const known = this.fromServer !== null || this.meals !== null || this.receipts !== null;
    if (!known) return null;
    return {
      review: this.receipts?.reviewCount ?? this.fromServer?.review ?? 0,
      meals: this.meals?.queue.length ?? this.receipts?.openMeals ?? this.fromServer?.meals ?? 0,
    };
  }

  serverCounts(counts: NavCounts): void {
    this.fromServer = counts;
  }

  /** The domain's page opened. The return is for when it closes: its last number stays until the server says otherwise. */
  openMeals(meals: MealsStore): () => void {
    this.meals = meals;
    this.mealOutbox.open = meals;
    meals.catchUp();
    return () => this.closeMeals(meals);
  }

  private closeMeals(meals: MealsStore): void {
    if (this.meals !== meals) return;
    this.fromServer = { review: this.counts?.review ?? 0, meals: meals.queue.length };
    this.meals = null;
    this.mealOutbox.open = null;
  }

  /** The refusals nothing on screen shows: the shell says them (`Refusals`). On the meals page a meal's needs no name: its row just came back. */
  get looseRefusals(): Refusal[] {
    const meals = [...this.mealOutbox.refusals.values()].map((r) => (this.meals ? { ...r, who: null } : r));
    return [...[...this.checkOutbox.refusals.values()].filter((r) => !this.checks?.shows(r.key)), ...meals];
  }

  closeRefusal(key: string): void {
    this.checkOutbox.clear(key);
    this.mealOutbox.clear(key);
  }

  /** The company left the screen: this store is thrown away, and its refusals must still reach the person. */
  leave(send: (refusal: Refusal) => void): void {
    this.checkOutbox.leave(send);
    this.mealOutbox.leave(send);
  }

  stay(): void {
    this.checkOutbox.stay();
    this.mealOutbox.stay();
  }

  /** The receipt checks opened. Unlike the meals they have no number in the navigation: only the spending page's tab reads them. */
  openChecks(checks: ChecksStore): () => void {
    this.checks = checks;
    this.checkOutbox.open = checks;
    checks.catchUp();
    return () => this.closeChecks(checks);
  }

  private closeChecks(checks: ChecksStore): void {
    if (this.checks !== checks) return;
    this.checks = null;
    this.checkOutbox.open = null;
  }

  /** The receipts page opened. The return is for when it closes: its last numbers stay until the server says otherwise. */
  openReceipts(receipts: ReceiptsStore): () => void {
    this.receipts = receipts;
    return () => this.closeReceipts(receipts);
  }

  private closeReceipts(receipts: ReceiptsStore): void {
    if (this.receipts !== receipts) return;
    this.fromServer = this.counts;
    this.receipts = null;
  }
}
