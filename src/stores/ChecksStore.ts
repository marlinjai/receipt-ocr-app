import { makeAutoObservable, observable } from 'mobx';
import type { CheckChange, ChecksView } from '@/app/app/spending/loop-actions';
import { checkYears, chooseChecks, splitAnswered, type CheckEdit, type ChecksChoice } from '@/app/app/spending/open-checks';
import { certainPairs, withoutReceipt } from '@/lib/spending/loop';
import type { PaymentCheck } from '@/lib/spending/loop-service';
import type { NotificationView } from '@/lib/spending/notify/service';

/** A change on screen whose answer from the server is still out. */
export interface LocalWrite {
  id: number;
  paymentId: string;
  edit: CheckEdit;
  /** The receipt it links: held back from the proposals of every other payment meanwhile. */
  rowId: string | null;
}

/** A change the server made. `state` is left out when a newer write on the same payment had its answer first. */
type Confirmed = Omit<CheckChange, 'state'> & { state?: CheckChange['state'] };

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
 * nothing back (`CheckChange.at`, `ChecksView.readAt`).
 */
export class ChecksStore {
  private byId = observable.map<string, PaymentCheck>([], { deep: false });
  /** The last whole view: the settings and everything else that is not a payment. */
  private page: ChecksView;
  /** What the server last said about each payment. A receipt linked since stands here with `has_receipt`, so a payment keeps its place. */
  private known: Map<string, PaymentCheck>;
  private writes: LocalWrite[] = [];
  private confirmed: Confirmed[] = [];
  private lastWrite = 0;
  /** Per payment, the newest write the server has answered: an answer to an older one comes too late. */
  private answeredUpTo = new Map<string, number>();
  /** Messages marked read: null while the answer is out, then when it happened. */
  private readNotes = observable.map<string, number | null>();
  private settledSubjects = observable.set<string>();
  /** The summary of the last "Jetzt prüfen"; the next action of this panel ends it. */
  lastRun: ChecksView['lastRun'];
  /** Counts what changed about the receipts: a list open for linking by hand is asked again when it changes. */
  dataVersion = 0;

  constructor(seed: ChecksView) {
    this.page = seed;
    this.lastRun = seed.lastRun;
    this.known = ChecksStore.byPayment(seed);
    this.draw();
    makeAutoObservable<ChecksStore, 'byId' | 'page' | 'known' | 'writes' | 'confirmed' | 'lastWrite' | 'answeredUpTo' | 'readNotes' | 'settledSubjects'>(
      this,
      {
        byId: false,
        page: observable.ref,
        known: false,
        writes: false,
        confirmed: false,
        lastWrite: false,
        answeredUpTo: false,
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

  /** What the list shows for a choice made in the view (the choice itself stays there). */
  filtered(choice: ChecksChoice, focusPaymentId: string | null): { shown: PaymentCheck[]; matching: number } {
    return chooseChecks(this.open, choice, focusPaymentId);
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
    this.confirmed = this.confirmed.filter((c) => c.at >= view.readAt);
    this.settledSubjects.clear();
    for (const [id, at] of [...this.readNotes]) if (at !== null && at < view.readAt) this.readNotes.delete(id);
    for (const change of this.confirmed) this.absorb(change);
    this.dataVersion += 1;
    this.draw();
  }

  /** The write shows at once; `confirm` or `refuse` end it. */
  begin(paymentId: string, edit: CheckEdit, rowId: string | null = null): LocalWrite {
    const write = { id: ++this.lastWrite, paymentId, edit, rowId };
    this.writes.push(write);
    this.lastRun = null;
    this.draw();
    return write;
  }

  confirm(write: LocalWrite, change: CheckChange): void {
    this.writes = this.writes.filter((w) => w !== write);
    // The answer to an older write coming after a newer one's says nothing about the payment any more. Its receipt is linked all the same.
    const late = (this.answeredUpTo.get(write.paymentId) ?? 0) > write.id;
    if (!late) this.answeredUpTo.set(write.paymentId, write.id);
    const confirmed: Confirmed = late ? { paymentId: change.paymentId, rowId: change.rowId, settled: change.settled, at: change.at } : change;
    this.confirmed.push(confirmed);
    this.absorb(confirmed);
    if (change.rowId !== null) this.dataVersion += 1;
    this.draw();
  }

  /** Refused, or no answer at all: this write leaves the pile, and nothing else does. */
  refuse(write: LocalWrite): void {
    this.writes = this.writes.filter((w) => w !== write);
    this.draw();
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
    for (const write of this.writes) if (check && write.paymentId === known.paymentId) check = write.edit(check);
    if (!check) return null;
    let { state } = check;
    for (const { rowId } of this.writes) if (rowId !== null) state = withoutReceipt(state, rowId);
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
