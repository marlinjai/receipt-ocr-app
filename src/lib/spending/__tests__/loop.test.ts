import { describe, expect, it } from 'vitest';
import { loopState, notNeededReason, notifiable, receiptCandidates, type LoopContext, type LoopPayment, type LoopReceipt } from '../loop';

/** Every name here is a brand or invented. */
const payment = (o: Partial<LoopPayment> = {}): LoopPayment => ({
  id: 'p1',
  bookingDay: '2026-05-10',
  amountCents: -2999,
  counterparty: 'Zyx Handel',
  counterpartyKey: 'zyx handel',
  reference: 'Bestellung 4711',
  kind: 'spend',
  linkCount: 0,
  ...o,
});
const receipt = (o: Partial<LoopReceipt> = {}): LoopReceipt => ({
  rowId: 'r1',
  label: 'Zyx Handel Rechnung',
  vendor: 'Zyx Handel GmbH',
  vendorKey: 'zyx handel',
  day: '2026-05-08',
  amountCents: 2999,
  estimated: false,
  linked: false,
  ...o,
});
const ctx = (o: Partial<LoopContext> = {}): LoopContext => ({
  treatments: new Map(),
  categoryAnswers: new Map(),
  noReceipt: new Map(),
  receipts: [],
  vendorAliases: new Map(),
  ...o,
});

describe('step 1: payments that need no receipt', () => {
  it.each([
    [{ kind: 'own_transfer' as const }, 'own_transfer'],
    [{ kind: 'income' as const, amountCents: 5000 }, 'income'],
    [{ kind: 'refund' as const, amountCents: 500 }, 'refund'],
    [{ kind: 'fee' as const }, 'fee'],
    [{ counterparty: 'Beispielbank', counterpartyKey: 'beispielbank', reference: 'Kreditrate 05/2026' }, 'loan'],
    [{ counterparty: '', counterpartyKey: '', reference: 'Geldautomat Markt' }, 'cash'],
    [{ kind: 'private' as const, amountCents: 5000 }, 'refund'],
  ])('%o needs none (%s)', (o, reason) => {
    expect(notNeededReason(payment(o), ctx())).toBe(reason);
  });

  it('follows the answers: an own account, or a person answered "transfer to a person"', () => {
    expect(notNeededReason(payment(), ctx({ treatments: new Map([['zyx handel', 'own_account']]) }))).toBe('own_transfer');
    expect(notNeededReason(payment(), ctx({ categoryAnswers: new Map([['zyx handel', 'transfers']]) }))).toBe('transfer');
  });

  it('asks for a receipt of every other purchase, private ones included', () => {
    expect(notNeededReason(payment(), ctx())).toBeNull();
    expect(notNeededReason(payment({ kind: 'private' }), ctx())).toBeNull();
  });
});

describe('step 2: a receipt that fits by vendor, amount and day', () => {
  it('proposes an unlinked receipt of the vendor with the exact amount near the day', () => {
    expect(receiptCandidates(payment(), ctx({ receipts: [receipt()] }))).toEqual([{ rowId: 'r1', label: 'Zyx Handel Rechnung', day: '2026-05-08', amountCents: 2999, estimated: false }]);
  });

  it('never proposes on amount and day alone, nor a linked receipt, nor a wrong amount or a far day', () => {
    expect(receiptCandidates(payment(), ctx({ receipts: [receipt({ vendorKey: 'ganz anders' })] }))).toEqual([]);
    expect(receiptCandidates(payment(), ctx({ receipts: [receipt({ linked: true })] }))).toEqual([]);
    expect(receiptCandidates(payment(), ctx({ receipts: [receipt({ amountCents: 3000 })] }))).toEqual([]);
    expect(receiptCandidates(payment(), ctx({ receipts: [receipt({ day: '2026-03-01' })] }))).toEqual([]);
    expect(receiptCandidates(payment(), ctx({ receipts: [receipt({ day: '2026-05-16' })] }))).toEqual([]);
    expect(receiptCandidates(payment(), ctx({ receipts: [receipt({ vendorKey: null })] }))).toEqual([]);
  });

  it('accepts a foreign-currency estimate within 8 percent, and a vendor named only by an earlier pairing', () => {
    expect(receiptCandidates(payment({ amountCents: -3100 }), ctx({ receipts: [receipt({ amountCents: 2950, estimated: true })] }))).toHaveLength(1);
    expect(receiptCandidates(payment({ amountCents: -3400 }), ctx({ receipts: [receipt({ amountCents: 2950, estimated: true })] }))).toEqual([]);
    const paired = payment({ counterparty: 'PP Editor', counterpartyKey: 'pp editor', reference: '' });
    expect(receiptCandidates(paired, ctx({ receipts: [receipt()] }))).toEqual([]);
    expect(receiptCandidates(paired, ctx({ receipts: [receipt()], vendorAliases: new Map([['pp editor', new Set(['zyx handel'])]]) }))).toHaveLength(1);
  });

  it('never proposes a receipt whose date is no real day', () => {
    expect(receiptCandidates(payment(), ctx({ receipts: [receipt({ day: '2026-13-45' })] }))).toEqual([]);
  });

  it('lists the closest day first', () => {
    const found = receiptCandidates(payment(), ctx({ receipts: [receipt({ rowId: 'far', day: '2026-04-01' }), receipt({ rowId: 'near', day: '2026-05-10' })] }));
    expect(found.map((c) => c.rowId)).toEqual(['near', 'far']);
  });
});

describe('loopState', () => {
  it('settles a linked payment first, whatever else is true', () => {
    expect(loopState(payment({ linkCount: 1, kind: 'fee' }), ctx())).toEqual({ state: 'has_receipt' });
  });

  it('keeps an answered "no receipt" settled, but only for a payment that would need one', () => {
    const answered = ctx({ noReceipt: new Map([['p1', 'Automat ohne Beleg']]), receipts: [receipt()] });
    expect(loopState(payment(), answered)).toEqual({ state: 'no_receipt', reason: 'Automat ohne Beleg' });
    expect(loopState(payment({ kind: 'own_transfer' }), answered)).toEqual({ state: 'not_needed', reason: 'own_transfer' });
  });

  it('names a mail attachment found for the payment, after a fitting receipt and before "missing"', () => {
    const mail = { id: 'mc1', fileName: 'Rechnung.pdf', receivedDay: '2026-05-09', subject: 'Rechnung', sender: 'billing@zyx.example' };
    const mails = new Map([['p1', [mail]]]);
    expect(loopState(payment(), ctx({ mailCandidates: mails }))).toEqual({ state: 'in_mailbox', mails: [mail] });
    expect(loopState(payment(), ctx({ mailCandidates: mails, receipts: [receipt()] })).state).toBe('proposed');
    expect(loopState(payment(), ctx({ mailCandidates: mails, noReceipt: new Map([['p1', 'x']]) })).state).toBe('no_receipt');
  });

  it('proposes when a receipt fits, and reports the receipt missing otherwise', () => {
    expect(loopState(payment(), ctx({ receipts: [receipt()] })).state).toBe('proposed');
    expect(loopState(payment(), ctx())).toEqual({ state: 'missing' });
  });
});

describe('notifiable', () => {
  it('notifies about the last two weeks only, never about the future', () => {
    expect(notifiable({ bookingDay: '2026-05-10' }, '2026-05-24')).toBe(true);
    expect(notifiable({ bookingDay: '2026-05-10' }, '2026-05-25')).toBe(false);
    expect(notifiable({ bookingDay: '2026-05-10' }, '2026-05-09')).toBe(false);
  });
});
