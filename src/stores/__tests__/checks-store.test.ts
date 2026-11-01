import { autorun } from 'mobx';
import { describe, expect, it } from 'vitest';
import type { CheckChange, ChecksView } from '@/app/app/spending/loop-actions';
import { answerTakenBack, answeredNoReceipt, mailSetAside, receiptLinked } from '@/app/app/spending/open-checks';
import { RECEIPT_NOT_FOUND, type LoopState } from '@/lib/spending/loop';
import type { PaymentCheck } from '@/lib/spending/loop-service';
import { AppStore } from '../AppStore';
import { ChecksStore } from '../ChecksStore';

const candidate = (rowId: string, estimated = false) => ({ rowId, label: rowId, day: '2026-05-01', amountCents: 1000, estimated });
const proposed = (...rowIds: string[]): LoopState => ({ state: 'proposed', candidates: rowIds.map((r) => candidate(r)) });
const mail = (id: string) => ({ id, fileName: `${id}.pdf`, receivedDay: '2026-05-01', subject: '', sender: '' });
const check = (paymentId: string, state: LoopState, bookingDay = '2026-05-10'): PaymentCheck => ({ paymentId, bookingDay, cents: 1000, counterparty: paymentId, reference: '', state });

const NOT_NEEDED = { old: 0, own_transfer: 2, income: 0, refund: 0, fee: 1, loan: 0, cash: 0, transfer: 0 };

const view = (open: PaymentCheck[], answered: PaymentCheck[] = [], o: Partial<ChecksView> = {}): ChecksView => ({
  readAt: 100,
  backlogBefore: '2026-05-01',
  loop: { open, answered, counts: { hasReceipt: 4, notNeeded: NOT_NEEDED, noReceipt: answered.length, proposed: 0, in_mailbox: 0, missing: 0 } },
  notifications: [],
  settings: { channel: 'push', notifyEmail: null },
  canWrite: true,
  lastRun: null,
  workspaceId: 'ws-a',
  mailbox: 'off',
  pushPublicKey: null,
  pushDevices: 0,
  ...o,
});

const change = (paymentId: string, state: CheckChange['state'], o: Partial<CheckChange> = {}): CheckChange => ({ paymentId, state, rowId: null, settled: [], at: 200, ...o });

const ids = (checks: PaymentCheck[]) => checks.map((c) => c.paymentId);
const stateOf = (store: ChecksStore, id: string) => [...store.open, ...store.answers.answered, ...store.answers.lost].find((c) => c.paymentId === id)?.state;

const link = (store: ChecksStore, paymentId: string, rowId: string) => store.begin(paymentId, receiptLinked, rowId);
const linkConfirmed = (paymentId: string, rowId: string, at = 200) => change(paymentId, { state: 'has_receipt' }, { rowId, at });

describe('what the checks work out', () => {
  it('sorts the lists newest first, whatever order a payment came back in', () => {
    const store = new ChecksStore(view([check('new', { state: 'missing' }, '2026-05-10'), check('old', { state: 'missing' }, '2026-03-01')], [check('mid', { state: 'no_receipt', reason: 'x' }, '2026-04-01')]));
    store.begin('mid', answerTakenBack);
    expect(ids(store.open)).toEqual(['new', 'mid', 'old']);
  });

  it('counts years, proposals and the backlog, which leaves out mails waiting to be taken over', () => {
    const store = new ChecksStore(
      view([
        check('a', proposed('r1'), '2026-05-10'),
        check('b', { state: 'in_mailbox', mails: [mail('m')] }, '2025-05-10'),
        check('c', { state: 'missing' }, '2025-04-10'),
      ]),
    );
    expect(store.years).toEqual([
      { year: '2026', count: 1 },
      { year: '2025', count: 2 },
    ]);
    expect(store.proposedCount).toBe(1);
    expect(store.backlogCount).toBe(1);
    expect(store.counts).toEqual({ hasReceipt: 4, inMailbox: 1, notNeeded: 3 });
  });

  it('keeps the lost answers apart', () => {
    const store = new ChecksStore(view([], [check('a', { state: 'no_receipt', reason: RECEIPT_NOT_FOUND }), check('b', { state: 'no_receipt', reason: 'Automat' })]));
    expect(ids(store.answers.lost)).toEqual(['a']);
    expect(ids(store.answers.answered)).toEqual(['b']);
  });

  it('filters with a choice the view holds, and keeps the payment a notification points at', () => {
    const store = new ChecksStore(view([check('a', proposed('r1'), '2026-05-10'), check('b', { state: 'missing' }, '2025-05-10')]));
    expect(ids(store.filtered({ year: '2026', onlyProposed: false, limit: 30 }, null).shown)).toEqual(['a']);
    expect(ids(store.filtered({ year: '2026', onlyProposed: false, limit: 30 }, 'b').shown)).toEqual(['b', 'a']);
    expect(store.filtered({ year: null, onlyProposed: true, limit: 30 }, null).matching).toBe(1);
  });
});

describe('an answer, forward', () => {
  it('moves the payment at once, and the server has the last word on its state', () => {
    const store = new ChecksStore(view([check('a', { state: 'missing' })]));
    const write = store.begin('a', answeredNoReceipt(' Automat '));
    expect(store.open).toEqual([]);
    expect(stateOf(store, 'a')).toEqual({ state: 'no_receipt', reason: 'Automat' });
    store.confirm(write, change('a', { state: 'no_receipt', reason: 'Automat (gekürzt)' }));
    expect(stateOf(store, 'a')).toEqual({ state: 'no_receipt', reason: 'Automat (gekürzt)' });
  });

  it('counts a link as having a receipt at once, and once only', () => {
    const store = new ChecksStore(view([check('a', proposed('r1'))]));
    const write = link(store, 'a', 'r1');
    expect(store.counts.hasReceipt).toBe(5);
    store.confirm(write, linkConfirmed('a', 'r1'));
    expect(store.counts.hasReceipt).toBe(5);
    expect(store.openCount).toBe(0);
    // A read that knows the link counts it itself.
    store.pageRead(view([], [], { readAt: 300, loop: { open: [], answered: [], counts: { hasReceipt: 5, notNeeded: NOT_NEEDED, noReceipt: 0, proposed: 0, in_mailbox: 0, missing: 0 } } }));
    expect(store.counts.hasReceipt).toBe(5);
  });

  it('a take back shows the payment as missing until the server says what fits', () => {
    const store = new ChecksStore(view([], [check('a', { state: 'no_receipt', reason: 'x' })]));
    const write = store.begin('a', answerTakenBack);
    expect(stateOf(store, 'a')).toEqual({ state: 'missing' });
    store.confirm(write, change('a', proposed('r1')));
    expect(stateOf(store, 'a')).toEqual(proposed('r1'));
  });

  it('a take back about a payment gone to another company takes it off the lists', () => {
    const store = new ChecksStore(view([], [check('a', { state: 'no_receipt', reason: 'x', movedAway: true })]));
    const write = store.begin('a', answerTakenBack);
    expect(stateOf(store, 'a')).toBeUndefined();
    store.confirm(write, change('a', null));
    expect(stateOf(store, 'a')).toBeUndefined();
    expect(store.counts.hasReceipt).toBe(4);
  });

  it('setting a mail aside leaves the other mails, and with none left the receipt is missing', () => {
    const store = new ChecksStore(view([check('a', { state: 'in_mailbox', mails: [mail('m1'), mail('m2')] })]));
    store.begin('a', mailSetAside('m1'));
    expect(stateOf(store, 'a')).toEqual({ state: 'in_mailbox', mails: [mail('m2')] });
    store.begin('a', mailSetAside('m2'));
    expect(stateOf(store, 'a')).toEqual({ state: 'missing' });
  });

  it('takes messages out of the queue only on the server\'s word, and leaves the others', () => {
    const notifications = [{ subjectKey: 'missing_receipt:a', id: 'n1' }, { subjectKey: 'missing_receipt:b', id: 'n2' }] as ChecksView['notifications'];
    const store = new ChecksStore(view([check('a', { state: 'missing' })], [], { notifications }));
    const write = store.begin('a', answeredNoReceipt('x'));
    expect(store.notifications).toHaveLength(2);
    store.confirm(write, change('a', { state: 'no_receipt', reason: 'x' }, { settled: ['missing_receipt:a'] }));
    expect(store.notifications.map((n) => n.id)).toEqual(['n2']);
  });

  it('ends the summary of the last run', () => {
    const lastRun = { loop: null } as ChecksView['lastRun'];
    const store = new ChecksStore(view([check('a', { state: 'missing' })], [], { lastRun }));
    store.begin('a', answeredNoReceipt('x'));
    expect(store.lastRun).toBeNull();
  });
});

describe('a receipt proposed to several payments', () => {
  it('leaves the others\' proposals at once, and the numbers follow', () => {
    const store = new ChecksStore(view([check('a', proposed('r1')), check('b', proposed('r1', 'r2')), check('c', proposed('r2'))]));
    expect(store.certainCount).toBe(0);
    link(store, 'a', 'r1');
    expect(stateOf(store, 'b')).toEqual(proposed('r2'));
    expect(store.proposedCount).toBe(2);
    // r2 is wanted by two payments: still not certain.
    expect(store.certainCount).toBe(0);
  });

  it('makes a remaining proposal certain once nothing else could have its receipt', () => {
    const store = new ChecksStore(view([check('a', proposed('r1')), check('b', proposed('r1'))]));
    expect(store.certainCount).toBe(0);
    const write = store.begin('a', answeredNoReceipt('x'));
    expect(store.certainCount).toBe(1);
    store.refuse(write);
    expect(store.certainCount).toBe(0);
  });

  it('a payment left with no proposal falls to its mails, or to missing', () => {
    const withMail: LoopState = { state: 'proposed', candidates: [candidate('r1')], mails: [mail('m')] };
    const store = new ChecksStore(view([check('a', proposed('r1', 'r9')), check('b', proposed('r1')), check('c', withMail)]));
    link(store, 'a', 'r1');
    expect(stateOf(store, 'b')).toEqual({ state: 'missing' });
    expect(stateOf(store, 'c')).toEqual({ state: 'in_mailbox', mails: [mail('m')] });
  });

  it('keeps every check it does not concern the same object', () => {
    const untouched = check('c', proposed('r2'));
    const store = new ChecksStore(view([check('a', proposed('r1')), check('b', proposed('r1')), untouched]));
    const write = link(store, 'a', 'r1');
    expect(store.open.find((c) => c.paymentId === 'c')).toBe(untouched);
    store.confirm(write, linkConfirmed('a', 'r1'));
    expect(store.open.find((c) => c.paymentId === 'c')).toBe(untouched);
  });

  it('asks an open list again only when a receipt moved', () => {
    const store = new ChecksStore(view([check('a', proposed('r1')), check('b', { state: 'missing' })]));
    const answer = store.begin('b', answeredNoReceipt('x'));
    store.confirm(answer, change('b', { state: 'no_receipt', reason: 'x' }));
    expect(store.dataVersion).toBe(0);
    store.confirm(link(store, 'a', 'r1'), linkConfirmed('a', 'r1'));
    expect(store.dataVersion).toBe(1);
  });
});

describe('a refusal, backtracking', () => {
  it('brings that payment back in its place, and the receipt back to the others', () => {
    const b = check('b', proposed('r1', 'r2'));
    const store = new ChecksStore(view([check('a', proposed('r1')), b]));
    const write = link(store, 'a', 'r1');
    store.refuse(write);
    expect(ids(store.open)).toEqual(['a', 'b']);
    expect(stateOf(store, 'a')).toEqual(proposed('r1'));
    // Nothing is left of the write: the very check the server sent is back.
    expect(store.open[1]).toBe(b);
  });

  it('touches nothing that happened since on other payments', () => {
    const store = new ChecksStore(view([check('a', proposed('r1')), check('b', proposed('r2')), check('c', proposed('r1', 'r2'))]));
    const first = link(store, 'a', 'r1');
    const second = link(store, 'b', 'r2');
    expect(stateOf(store, 'c')).toEqual({ state: 'missing' });
    store.refuse(first);
    // r2 stays taken: a snapshot from before the first link would have put it back.
    expect(stateOf(store, 'c')).toEqual(proposed('r1'));
    expect(ids(store.open)).toEqual(['a', 'c']);
    store.confirm(second, linkConfirmed('b', 'r2'));
    expect(stateOf(store, 'c')).toEqual(proposed('r1'));
  });

  it('a receipt confirmed stays gone when another write on the same receipt is refused', () => {
    const store = new ChecksStore(view([check('a', proposed('r1')), check('b', proposed('r1')), check('c', proposed('r1', 'r2'))]));
    const first = link(store, 'a', 'r1');
    const second = link(store, 'b', 'r1');
    store.confirm(first, linkConfirmed('a', 'r1'));
    store.refuse(second);
    expect(stateOf(store, 'b')).toEqual({ state: 'missing' });
    expect(stateOf(store, 'c')).toEqual(proposed('r2'));
  });

  it('a refused notification read comes back', () => {
    const notifications = [{ subjectKey: 's', id: 'n1' }] as ChecksView['notifications'];
    const store = new ChecksStore(view([], [], { notifications }));
    store.markRead('n1');
    expect(store.notifications).toEqual([]);
    store.readRefused('n1');
    expect(store.notifications).toHaveLength(1);
  });

  it('changing an answer before it was confirmed: the newest write is what shows', () => {
    const store = new ChecksStore(view([check('a', { state: 'missing' })]));
    store.begin('a', answeredNoReceipt('x'));
    store.begin('a', answerTakenBack);
    expect(stateOf(store, 'a')).toEqual({ state: 'missing' });
  });
});

describe('a late answer', () => {
  it('does not overwrite a newer change still on its way', () => {
    const store = new ChecksStore(view([check('a', { state: 'missing' })]));
    const answer = store.begin('a', answeredNoReceipt('x'));
    store.begin('a', answerTakenBack);
    store.confirm(answer, change('a', { state: 'no_receipt', reason: 'x' }));
    expect(stateOf(store, 'a')).toEqual({ state: 'missing' });
  });

  it('does not overwrite a newer change already confirmed', () => {
    const store = new ChecksStore(view([check('a', { state: 'missing' })]));
    const answer = store.begin('a', answeredNoReceipt('x'));
    const takeBack = store.begin('a', answerTakenBack);
    store.confirm(takeBack, change('a', proposed('r1'), { at: 210 }));
    store.confirm(answer, change('a', { state: 'no_receipt', reason: 'x' }, { at: 200 }));
    expect(stateOf(store, 'a')).toEqual(proposed('r1'));
    // Nor when a read lays the confirmed changes over itself again.
    store.pageRead(view([check('a', { state: 'missing' })], [], { readAt: 150 }));
    expect(stateOf(store, 'a')).toEqual(proposed('r1'));
  });

  it('falls back on the older answer when the newer change is refused', () => {
    const store = new ChecksStore(view([check('a', { state: 'missing' })]));
    const answer = store.begin('a', answeredNoReceipt('x'));
    const takeBack = store.begin('a', answerTakenBack);
    store.confirm(answer, change('a', { state: 'no_receipt', reason: 'x' }));
    store.refuse(takeBack);
    expect(stateOf(store, 'a')).toEqual({ state: 'no_receipt', reason: 'x' });
  });

  it('still takes the receipt out of the proposals when its payment moved on', () => {
    const store = new ChecksStore(view([check('a', proposed('r1')), check('b', proposed('r1', 'r2'))]));
    const linked = link(store, 'a', 'r1');
    const newer = store.begin('a', answeredNoReceipt('x'));
    store.confirm(newer, change('a', { state: 'no_receipt', reason: 'x' }));
    store.confirm(linked, linkConfirmed('a', 'r1'));
    expect(stateOf(store, 'b')).toEqual(proposed('r2'));
  });
});

describe('a read arriving, resuming', () => {
  it('slides in under a write still on its way', () => {
    const store = new ChecksStore(view([check('a', proposed('r1')), check('b', proposed('r1'))]));
    const write = link(store, 'a', 'r1');
    store.pageRead(view([check('a', proposed('r1')), check('b', proposed('r1')), check('c', { state: 'missing' })], [], { readAt: 150 }));
    expect(ids(store.open)).toEqual(['b', 'c']);
    expect(stateOf(store, 'b')).toEqual({ state: 'missing' });
    store.refuse(write);
    expect(ids(store.open)).toEqual(['a', 'b', 'c']);
  });

  it('lays what the server confirmed after it started over it again, receipts and messages too', () => {
    const notifications = [{ subjectKey: 'missing_receipt:a', id: 'n1' }] as ChecksView['notifications'];
    const seed = view([check('a', proposed('r1')), check('b', proposed('r1', 'r2'))], [], { notifications });
    const store = new ChecksStore(seed);
    store.confirm(link(store, 'a', 'r1'), { ...linkConfirmed('a', 'r1'), settled: ['missing_receipt:a'] });
    store.pageRead({ ...seed, readAt: 150 });
    expect(ids(store.open)).toEqual(['b']);
    expect(stateOf(store, 'b')).toEqual(proposed('r2'));
    expect(store.notifications).toEqual([]);
  });

  it('believes a read that started after the change', () => {
    const seed = view([check('a', { state: 'missing' })]);
    const store = new ChecksStore(seed);
    store.confirm(store.begin('a', answeredNoReceipt('x')), change('a', { state: 'no_receipt', reason: 'x' }, { at: 200 }));
    // Taken back in another tab, say.
    store.pageRead({ ...seed, readAt: 250 });
    expect(stateOf(store, 'a')).toEqual({ state: 'missing' });
  });

  it('keeps a notification read until a read knows it', () => {
    const notifications = [{ subjectKey: 's', id: 'n1' }] as ChecksView['notifications'];
    const seed = view([], [], { notifications });
    const store = new ChecksStore(seed);
    store.markRead('n1');
    store.pageRead({ ...seed, readAt: 150 });
    expect(store.notifications).toEqual([]);
    store.readConfirmed('n1', 200);
    store.pageRead({ ...seed, readAt: 180 });
    expect(store.notifications).toEqual([]);
    store.pageRead({ ...seed, readAt: 250 });
    expect(store.notifications).toHaveLength(1);
  });

  it('drops a read older than the one it has', () => {
    const store = new ChecksStore(view([check('a', { state: 'missing' })], [], { readAt: 300 }));
    store.pageRead(view([], [], { readAt: 200 }));
    expect(store.openCount).toBe(1);
  });

  it('a new visit starts from what the server sent, with nothing of the last one', () => {
    const seed = view([check('a', proposed('r1'))]);
    const first = new ChecksStore(seed);
    link(first, 'a', 'r1');
    const second = new ChecksStore(seed);
    expect(ids(second.open)).toEqual(['a']);
  });

  it('a page read keeps the summary, a whole answer brings its own', () => {
    const lastRun = { loop: null } as ChecksView['lastRun'];
    const seed = view([], [], { lastRun });
    const store = new ChecksStore(seed);
    store.pageRead(view([], [], { readAt: 150 }));
    expect(store.lastRun).toBe(lastRun);
    store.replaced(view([], [], { readAt: 160 }));
    expect(store.lastRun).toBeNull();
  });

  it('a read counts as fresh data for an open list, the same read twice does not', () => {
    const seed = view([]);
    const store = new ChecksStore(seed);
    store.pageRead(seed);
    expect(store.dataVersion).toBe(0);
    store.pageRead({ ...seed, readAt: 101 });
    expect(store.dataVersion).toBe(1);
  });
});

describe('after a bulk action, re-entering', () => {
  it('replaces everything, keeps a write on its way, and the payment can be answered again', () => {
    const store = new ChecksStore(view([check('a', { state: 'missing' }), check('b', { state: 'missing' })]));
    const write = store.begin('a', answeredNoReceipt('x'));
    store.replaced(view([check('a', { state: 'missing' })], [], { readAt: 150 }));
    expect(ids(store.open)).toEqual([]);
    store.refuse(write);
    expect(ids(store.open)).toEqual(['a']);
    const again = store.begin('a', answeredNoReceipt('y'));
    store.confirm(again, change('a', { state: 'no_receipt', reason: 'y' }));
    expect(stateOf(store, 'a')).toEqual({ state: 'no_receipt', reason: 'y' });
  });
});

describe('the count on the tab', () => {
  it('follows the store while the checks are open, and not after', () => {
    const app = new AppStore();
    const store = new ChecksStore(view([check('a', { state: 'missing' }), check('b', { state: 'missing' })]));
    const close = app.openChecks(store);
    const seen: Array<number | undefined> = [];
    const stop = autorun(() => seen.push(app.checks?.openCount));
    store.begin('a', answeredNoReceipt('x'));
    // Another change to the same count is no change: nothing redraws.
    store.pageRead(view([check('a', { state: 'missing' }), check('b', { state: 'missing' })], [], { readAt: 150 }));
    expect(seen).toEqual([2, 1]);
    close();
    expect(app.checks).toBeNull();
    stop();
  });

  it('does not let an old page close over a newer one', () => {
    const app = new AppStore();
    const closeOld = app.openChecks(new ChecksStore(view([])));
    const newer = new ChecksStore(view([]));
    app.openChecks(newer);
    closeOld();
    expect(app.checks).toBe(newer);
  });
});
