import { makeAutoObservable, observable } from 'mobx';
import type { CheckChange, ChecksView } from '@/app/app/spending/loop-actions';
import { checkYears, chooseChecks, splitAnswered, type CheckEdit, type ChecksChoice } from '@/app/app/spending/open-checks';
import { certainPairs, withoutReceipt } from '@/lib/spending/loop';
import type { PaymentCheck } from '@/lib/spending/loop-service';
import type { NotificationView } from '@/lib/spending/notify/service';
import { ChecksOutbox, checkKey, type Confirmed, type LocalWrite } from './ChecksOutbox';

const newest = (a: PaymentCheck, b: PaymentCheck) => (a.bookingDay < b.bookingDay ? 1 : a.bookingDay > b.bookingDay ? -1 : 0);

const isOpen = ({ state }: PaymentCheck) => state.state === 'proposed' || state.state === 'in_mailbox' || state.state === 'missing';

/**
 * The receipt checks on the client: the one copy of what the server sent, by
 * payment, and everything worked out from it. A check is replaced whole, never
 * changed in place, so a row can tell by its check whether it has to redraw.
 *
 * What is on screen is always worked out anew from two things: what the server
 * last said about each payment, and the writes still on their way, on top of it
 * in order. That is what makes the hard cases plain. A refused write just leaves
 * the pile: its payment, and the proposals it held a receipt back from, come
 * back as they are by now, whatever else happened to them meanwhile. A fresh read
 * slides in underneath without undoing a write. And what the server confirmed
 * after a read started is laid over that read again, so a late read brings
 * nothing back (`CheckChange.at`, `ChecksView.readAt`). The pile and the refusals
 * live in the `ChecksOutbox`, which outlives a visit of the panel.
 */
export class ChecksStore {
  private byId = observable.map<string, PaymentCheck>([], { deep: false });
  /** The last whole view: the settings and everything else that is not a payment. */
  private page: ChecksView;
  /** What the server last said about each payment. A receipt linked since stands here with `has_receipt`, so a payment keeps its place. */
  private known: Map<string, PaymentCheck>;
  private outbox: ChecksOutbox;
  /** Messages marked read: null while the answer is out, then when it happened. */
  private readNotes = observable.map<string, number | null>();
  private settledSubjects = observable.set<string>();
  /** The summary of the last "Jetzt prüfen"; the next action of this panel ends it. */
  lastRun: ChecksView['lastRun'];
  /** Counts what changed about the receipts: a list open for linking by hand is asked again when it changes. */
  dataVersion = 0;

  constructor(seed: ChecksView, outbox = new ChecksOutbox()) {
    this.outbox = outbox;
    this.page = seed;
    this.lastRun = seed.lastRun;
    this.known = ChecksStore.byPayment(seed);
    this.absorbConfirmed();
    this.draw();
    makeAutoObservable<ChecksStore, 'byId' | 'page' | 'known' | 'outbox' | 'readNotes' | 'settledSubjects'>(
      this,
      {
        byId: false,
        page: observable.ref,
        known: false,
        outbox: false,
        readNotes: false,
        settledSubjects: false,
        lastRun: observable.ref,
      },
      { autoBind: true },
    );
  }

  private static byPayment(view: ChecksView): Map<string, PaymentCheck> {
    return new Map([...view.loop.open, ...view.loop.answered].map((c) => [c.paymentId, c]));
  }

  private get all(): PaymentCheck[] {
    return [...this.byId.values()].sort(newest);
  }

  get open(): PaymentCheck[] {
    return this.all.filter(isOpen);
  }

  get openCount(): number {
    return this.open.length;
  }

  /** Every "no receipt" answer, the lost ones (`splitAnswered`) apart. */
  get answers(): ReturnType<typeof splitAnswered<PaymentCheck>> {
    return splitAnswered(this.all.filter((c) => c.state.state === 'no_receipt'));
  }

  get years(): Array<{ year: string; count: number }> {
    return checkYears(this.open);
  }

  get proposedCount(): number {
    return this.open.filter((c) => c.state.state === 'proposed').length;
  }

  /** How many open payments have one certain receipt, linked in one go by `linkCertain`. */
  get certainCount(): number {
    return certainPairs(this.open).length;
  }

  /** What closing the backlog takes: open from before `backlogBefore`, and no mail waiting to be taken over. */
  get backlogCount(): number {
    return this.open.filter((c) => c.bookingDay < this.page.backlogBefore && c.state.state !== 'in_mailbox').length;
  }

  /** The numbers about payments that are not listed: the server's, and what was settled here since. */
  get counts(): { hasReceipt: number; inMailbox: number; notNeeded: number } {
    const { hasReceipt, notNeeded } = this.page.loop.counts;
    const settled = [...this.byId.values()];
    return {
      hasReceipt: hasReceipt + settled.filter((c) => c.state.state === 'has_receipt').length,
      inMailbox: this.open.filter((c) => c.state.state === 'in_mailbox').length,
      notNeeded: Object.values(notNeeded).reduce((s, n) => s + n, 0) + settled.filter((c) => c.state.state === 'not_needed').length,
    };
  }

  get notifications(): NotificationView[] {
    return this.page.notifications.filter((n) => !this.readNotes.has(n.id) && !this.settledSubjects.has(n.subjectKey));
  }

  get settings(): ChecksView['settings'] {
    return this.page.settings;
  }

  get canWrite(): boolean {
    return this.page.canWrite;
  }

  get workspaceId(): string {
    return this.page.workspaceId;
  }

  get mailbox(): ChecksView['mailbox'] {
    return this.page.mailbox;
  }

  get pushPublicKey(): string | null {
    return this.page.pushPublicKey;
  }

  get pushDevices(): number {
    return this.page.pushDevices;
  }

  get backlogBefore(): string {
    return this.page.backlogBefore;
  }

  /**
   * What the list shows for a choice made in the view (the choice itself stays there). A payment with a refusal
   * is there whatever the choice: its message stands at its row, and the row must be on screen to say it.
   */
  filtered(choice: ChecksChoice, focusPaymentId: string | null): { shown: PaymentCheck[]; matching: number } {
    const { shown, matching } = chooseChecks(this.open, choice, focusPaymentId);
    const refused = this.open.filter((c) => this.outbox.refusals.has(checkKey(c.paymentId)) && !shown.includes(c));
    return { shown: [...refused, ...shown], matching };
  }

  /** For the name of a payment in a message. */
  find(paymentId: string): PaymentCheck | undefined {
    return this.byId.get(paymentId);
  }

  errorAt(key: string): string | null {
    return this.outbox.refusals.get(key)?.message ?? null;
  }

  say(key: string, who: string | null, message: string): void {
    this.outbox.say(key, who, message);
  }

  clearError(key: string): void {
    this.outbox.clear(key);
  }

  /** Does the panel have a place for this refusal? A payment that left the lists has none; the page as a whole always does. */
  shows(key: string): boolean {
    const colon = key.indexOf(':');
    if (colon < 0) return true;
    const [kind, id] = [key.slice(0, colon), key.slice(colon + 1)];
    if (kind === 'note') return this.notifications.some((n) => n.id === id);
    const check = this.byId.get(id);
    return check !== undefined && (isOpen(check) || check.state.state === 'no_receipt');
  }

  /** The page read the checks afresh after a change elsewhere on it. The summary of "Jetzt prüfen" stays: the page's read carries none. */
  pageRead(view: ChecksView): void {
    if (view !== this.page) this.tookRead(view);
  }

  /** A whole view as the answer of an action of this panel: the summary is the action's. */
  replaced(view: ChecksView): void {
    this.lastRun = view.lastRun;
    this.tookRead(view);
  }

  private tookRead(view: ChecksView): void {
    // Two reads can overtake each other as well.
    if (view.readAt < this.page.readAt) return;
    this.page = view;
    this.known = ChecksStore.byPayment(view);
    this.outbox.forget(view.readAt);
    this.settledSubjects.clear();
    for (const [id, at] of [...this.readNotes]) if (at !== null && at < view.readAt) this.readNotes.delete(id);
    this.absorbConfirmed();
    this.dataVersion += 1;
    this.draw();
  }

  /** The write shows at once; `confirm` or `refuse` end it. */
  begin(paymentId: string, edit: CheckEdit, rowId: string | null = null): LocalWrite {
    const write = this.outbox.begin(paymentId, edit, rowId);
    this.lastRun = null;
    this.draw();
    return write;
  }

  confirm(write: LocalWrite, change: CheckChange): void {
    const confirmed = this.outbox.confirm(write, change);
    for (const store of this.openStores()) store.tookConfirmed(confirmed);
  }

  /** Refused, or no answer at all: this write leaves the pile, and nothing else does. */
  refuse(write: LocalWrite): void {
    this.outbox.refuse(write);
    for (const store of this.openStores()) store.draw();
  }

  /** The panel opened: what was confirmed between reading this store's seed and now. */
  catchUp(): void {
    this.absorbConfirmed();
    this.draw();
  }

  /** A write can end after the panel it began in closed: the store on screen by now has to hear of it. */
  private openStores(): Set<ChecksStore> {
    return new Set(this.outbox.open ? [this, this.outbox.open] : [this]);
  }

  private tookConfirmed(confirmed: Confirmed): void {
    this.absorb(confirmed);
    if (confirmed.rowId !== null) this.dataVersion += 1;
    this.draw();
  }

  private absorbConfirmed(): void {
    for (const change of this.outbox.confirmed) if (change.at >= this.page.readAt) this.absorb(change);
  }

  markRead(id: string): void {
    this.lastRun = null;
    this.readNotes.set(id, null);
  }

  readConfirmed(id: string, at: number): void {
    this.readNotes.set(id, at);
  }

  readRefused(id: string): void {
    this.readNotes.delete(id);
  }

  /** What the server said becomes what is known. */
  private absorb({ paymentId, state, rowId, settled }: Confirmed): void {
    const check = this.known.get(paymentId);
    if (check && state !== undefined) {
      if (state === null) this.known.delete(paymentId);
      else this.known.set(paymentId, { ...check, state });
    }
    if (rowId !== null) {
      for (const [id, other] of this.known) {
        const left = withoutReceipt(other.state, rowId);
        if (left !== other.state) this.known.set(id, { ...other, state: left });
      }
    }
    for (const subject of settled) this.settledSubjects.add(subject);
  }

  private shown(known: PaymentCheck): PaymentCheck | null {
    let check: PaymentCheck | null = known;
    for (const write of this.outbox.writes) if (check && write.paymentId === known.paymentId) check = write.edit(check);
    if (!check) return null;
    let { state } = check;
    for (const { rowId } of this.outbox.writes) if (rowId !== null) state = withoutReceipt(state, rowId);
    return state === check.state ? check : { ...check, state };
  }

  /** Only what really changed gets a new object here: every other row keeps its check, and with it stays as drawn. */
  private draw(): void {
    const entries: Array<[string, PaymentCheck]> = [];
    for (const [id, known] of this.known) {
      const check = this.shown(known);
      if (check) entries.push([id, check]);
    }
    this.byId.replace(entries);
  }
}
