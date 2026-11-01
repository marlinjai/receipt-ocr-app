import { computed, makeAutoObservable, observable } from 'mobx';
import type { NavCounts } from '@/app/app/nav-actions';
import type { ChecksStore } from './ChecksStore';
import type { MealsStore } from './MealsStore';

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
  private fromServer: NavCounts | null = null;
  /** Numbers a page reports while it is open, for domains without a store yet. */
  private reported: Partial<NavCounts> = {};

  constructor() {
    makeAutoObservable<AppStore, 'fromServer' | 'reported'>(this, { meals: observable.ref, checks: observable.ref, fromServer: observable.ref, reported: observable.ref, counts: computed.struct }, { autoBind: true });
  }

  get counts(): NavCounts | null {
    const known = this.fromServer !== null || this.meals !== null || Object.keys(this.reported).length > 0;
    if (!known) return null;
    return {
      review: this.reported.review ?? this.fromServer?.review ?? 0,
      meals: this.meals?.queue.length ?? this.reported.meals ?? this.fromServer?.meals ?? 0,
    };
  }

  serverCounts(counts: NavCounts): void {
    this.fromServer = counts;
  }

  /** The domain's page opened. The return is for when it closes: its last number stays until the server says otherwise. */
  openMeals(meals: MealsStore): () => void {
    this.meals = meals;
    return () => this.closeMeals(meals);
  }

  private closeMeals(meals: MealsStore): void {
    if (this.meals !== meals) return;
    this.fromServer = { review: this.counts?.review ?? 0, meals: meals.queue.length };
    this.meals = null;
  }

  /** The receipt checks opened. Unlike the meals they have no number in the navigation: only the spending page's tab reads them. */
  openChecks(checks: ChecksStore): () => void {
    this.checks = checks;
    return () => this.closeChecks(checks);
  }

  private closeChecks(checks: ChecksStore): void {
    if (this.checks === checks) this.checks = null;
  }

  report(numbers: Partial<NavCounts>): void {
    this.reported = { ...this.reported, ...numbers };
  }

  /** The reporting page closed. What it reported stays, as the last word, until the server's next answer. */
  stopReporting(): void {
    this.fromServer = this.counts;
    this.reported = {};
  }
}
