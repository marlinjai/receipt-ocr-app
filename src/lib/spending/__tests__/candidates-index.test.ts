import { describe, expect, it } from 'vitest';
import { vendorNamed } from '@/lib/tax/payments/match';
import { ESTIMATE_TOLERANCE_PERCENT, RECEIPT_DAYS_AFTER_PAYMENT, RECEIPT_DAYS_BEFORE_PAYMENT, receiptCandidates, type LoopPayment, type LoopReceipt, type ReceiptCandidate } from '../loop';
import { normalizeText } from '../rules';

/**
 * `receiptCandidates` looks only at receipts of the payment's amount (plan
 * docs/plans/2026-10-26-fast-dashboard-and-spending.md, decision 4). This
 * proves it finds exactly what a pass over every receipt finds, in the same
 * order: the pass below is the rule as it stood before the index.
 */
const dayNumber = (day: string) => Math.round(Date.parse(`${day}T00:00:00Z`) / 86_400_000);

function everyReceipt(payment: LoopPayment, receipts: readonly LoopReceipt[], vendorAliases: Map<string, Set<string>>): ReceiptCandidate[] {
  const paid = Math.abs(payment.amountCents);
  const booked = dayNumber(payment.bookingDay);
  if (!Number.isFinite(booked)) return [];
  const referenceKey = normalizeText(payment.reference);
  const aliases = vendorAliases.get(payment.counterpartyKey);
  const out: ReceiptCandidate[] = [];
  for (const r of receipts) {
    if (r.linked || r.vendorKey === null || r.day === null || r.amountCents === null || r.amountCents <= 0) continue;
    const gap = booked - dayNumber(r.day);
    if (!Number.isFinite(gap)) continue;
    if (gap > RECEIPT_DAYS_BEFORE_PAYMENT || gap < -RECEIPT_DAYS_AFTER_PAYMENT) continue;
    const fits = r.estimated ? Math.abs(paid - r.amountCents) * 100 <= ESTIMATE_TOLERANCE_PERCENT * r.amountCents : paid === r.amountCents;
    if (!fits) continue;
    if (!vendorNamed(r.vendorKey, payment.counterpartyKey, referenceKey) && !aliases?.has(r.vendorKey)) continue;
    out.push({ rowId: r.rowId, label: r.label, day: r.day, amountCents: r.amountCents, estimated: r.estimated });
  }
  return out.sort((a, b) => Math.abs(booked - dayNumber(a.day)) - Math.abs(booked - dayNumber(b.day)));
}

/** A small seeded generator, so a failure can be run again. */
function random(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1_103_515_245 + 12_345) % 2_147_483_648;
    return s / 2_147_483_648;
  };
}

const VENDORS = ['rewe', 'edeka', 'amazon', 'deutsche bahn', 'cafe nord'];
const pick = <T,>(next: () => number, list: readonly T[]) => list[Math.floor(next() * list.length)];
const day = (offset: number) => new Date(Date.UTC(2025, 5, 1) + offset * 86_400_000).toISOString().slice(0, 10);

function receiptsFor(next: () => number, count: number): LoopReceipt[] {
  return Array.from({ length: count }, (_, i) => {
    const vendor = next() < 0.1 ? null : pick(next, VENDORS);
    const roll = next();
    return {
      rowId: `r${i}`,
      label: `Beleg ${i}`,
      vendor,
      vendorKey: vendor,
      // Some without a day, some with a day that is no real day.
      day: roll < 0.05 ? null : roll < 0.08 ? '2025-13-45' : day(Math.floor(next() * 140) - 70),
      // Amounts from a short list, so many receipts share one; some empty, zero or negative.
      amountCents: roll > 0.95 ? null : roll > 0.92 ? 0 : roll > 0.9 ? -500 : pick(next, [999, 1000, 1050, 2500, 4999]),
      estimated: next() < 0.25,
      linked: next() < 0.15,
    };
  });
}

function paymentFor(next: () => number, i: number): LoopPayment {
  const vendor = pick(next, VENDORS);
  return {
    id: `p${i}`,
    bookingDay: next() < 0.03 ? 'not a day' : day(Math.floor(next() * 100) - 50),
    amountCents: -pick(next, [999, 1000, 1020, 1050, 2400, 2500, 4999, 7777]),
    counterparty: next() < 0.2 ? 'Unbekannt' : vendor.toUpperCase(),
    counterpartyKey: next() < 0.2 ? 'unbekannt' : vendor,
    reference: next() < 0.3 ? `Einkauf ${vendor}` : '',
    kind: 'spend',
    linkCount: 0,
  };
}

describe('receiptCandidates with the amount index', () => {
  it('finds exactly what a pass over every receipt finds, in the same order', () => {
    let withCandidates = 0;
    let withSeveral = 0;
    for (const seed of [1, 2, 3, 42, 2026]) {
      const next = random(seed);
      const receipts = receiptsFor(next, 300);
      const vendorAliases = new Map([['unbekannt', new Set(['cafe nord'])]]);
      for (let i = 0; i < 200; i++) {
        const payment = paymentFor(next, i);
        const expected = everyReceipt(payment, receipts, vendorAliases);
        expect(receiptCandidates(payment, { receipts, vendorAliases }), `seed ${seed}, payment ${i}`).toEqual(expected);
        if (expected.length > 0) withCandidates += 1;
        if (expected.length > 1) withSeveral += 1;
      }
    }
    // The generated cases reach the interesting part: proposals, and several to order.
    expect(withCandidates).toBeGreaterThan(100);
    expect(withSeveral).toBeGreaterThan(30);
  });

  it('holds at both ends of the day window and the estimate tolerance', () => {
    const base = { label: 'Beleg', vendor: 'rewe', vendorKey: 'rewe', linked: false };
    const receipts: LoopReceipt[] = [
      { ...base, rowId: 'first-day', day: day(-RECEIPT_DAYS_BEFORE_PAYMENT), amountCents: 1000, estimated: false },
      { ...base, rowId: 'too-early', day: day(-RECEIPT_DAYS_BEFORE_PAYMENT - 1), amountCents: 1000, estimated: false },
      { ...base, rowId: 'last-day', day: day(RECEIPT_DAYS_AFTER_PAYMENT), amountCents: 1000, estimated: false },
      { ...base, rowId: 'too-late', day: day(RECEIPT_DAYS_AFTER_PAYMENT + 1), amountCents: 1000, estimated: false },
      { ...base, rowId: 'estimate-edge', day: day(0), amountCents: 926, estimated: true },
      { ...base, rowId: 'estimate-out', day: day(0), amountCents: 925, estimated: true },
    ];
    const payment: LoopPayment = { id: 'p', bookingDay: day(0), amountCents: -1000, counterparty: 'REWE', counterpartyKey: 'rewe', reference: '', kind: 'spend', linkCount: 0 };
    const found = receiptCandidates(payment, { receipts, vendorAliases: new Map() }).map((c) => c.rowId);
    expect(found).toEqual(everyReceipt(payment, receipts, new Map()).map((c) => c.rowId));
    expect(found).toEqual(['estimate-edge', 'last-day', 'first-day']);
  });

  it('reads a new list of receipts afresh', () => {
    const base = { label: 'Beleg', vendor: 'rewe', vendorKey: 'rewe', day: day(0), estimated: false };
    const payment: LoopPayment = { id: 'p', bookingDay: day(0), amountCents: -1000, counterparty: 'REWE', counterpartyKey: 'rewe', reference: '', kind: 'spend', linkCount: 0 };
    const before = [{ ...base, rowId: 'a', amountCents: 1000, linked: false }];
    expect(receiptCandidates(payment, { receipts: before, vendorAliases: new Map() }).map((c) => c.rowId)).toEqual(['a']);
    // After a link the loop builds a new list: the linked receipt is no candidate any more.
    const after = [{ ...base, rowId: 'a', amountCents: 1000, linked: true }];
    expect(receiptCandidates(payment, { receipts: after, vendorAliases: new Map() })).toEqual([]);
  });
});
