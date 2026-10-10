import { describe, expect, it } from 'vitest';
import * as F from '@/lib/extraction/__tests__/fixtures';
import { newReading, proposeReading, type StoredReading } from '../reading';
import { reviewReasons, type ReviewSnapshot } from '../reasons';

/**
 * Receipts stored by the old reader, against what the current reader makes of
 * the same stored text. The "stored" values below are the kind of values the
 * first live upload left behind.
 */

const stored = (text: string, overrides: Partial<StoredReading> = {}): StoredReading => ({
  name: 'Abendessen',
  vendor: 'Lokal Beispiel',
  gross: 10,
  net: 8.4,
  taxRate: 19,
  tip: null,
  category: 'Bewirtung',
  text,
  ...overrides,
});

const byField = (changes: ReturnType<typeof proposeReading>) => Object.fromEntries(changes.map((c) => [c.field, [c.from, c.to]]));

describe('proposeReading', () => {
  it('a receipt number stored as the total: the bill, its net and rate, and the tip apart', () => {
    const changes = proposeReading(stored(F.CAFE_WITH_RECEIPT_NUMBERS, { vendor: 'Cafe Morgenrot', gross: 916752.88, net: 916694.18, taxRate: 0.01 }));
    expect(byField(changes)).toEqual({ gross: [916752.88, 58.7], net: [916694.18, 49.33], taxRate: [0.01, 19], tip: [null, 2.7] });
  });

  it('a total that includes the tip is offered as bill plus tip', () => {
    const changes = proposeReading(stored(F.THAI_TOTAL_TIP_GRAND_TOTAL, { vendor: 'Bangkok Garten', gross: 50, net: 42.02 }));
    expect(byField(changes)).toEqual({ gross: [50, 45.2], net: [42.02, 37.98], tip: [null, 4.8] });
  });

  it('a slogan stored as the vendor, and one word of a three-line name', () => {
    expect(byField(proposeReading(stored(F.FOODBAR_TWO_RATES, { vendor: 'Since 2016', gross: 37.7, net: 35.14, taxRate: 7 })))).toEqual({
      vendor: ['Since 2016', 'Fantastic Foodbar'],
    });
    expect(byField(proposeReading(stored(F.INDIAN_NAME_IN_THREE_LINES, { vendor: 'Indisches', gross: 30.4, net: 25.55 })))).toEqual({
      vendor: ['Indisches', 'Indisches Restaurant Shanti'],
    });
  });

  it('a bar stored as software becomes a meal, with the net the tax lines give', () => {
    const changes = proposeReading(stored(F.BAR_WITH_SERVER, { vendor: 'Hopfen Retail Germany GmbH', gross: 40.5, net: 4.29, taxRate: 844.06, category: 'Software & Lizenzen' }));
    expect(byField(changes)).toEqual({ net: [4.29, 34.04], taxRate: [844.06, 19], category: ['Software & Lizenzen', 'Bewirtung'] });
  });

  it('a receipt the reader agrees with gets no proposal', () => {
    expect(proposeReading(stored(F.TAVERNA, { vendor: 'TAVERNA BEISPIEL', gross: 45.3, net: 38.07 }))).toEqual([]);
    // Spelling and case of the vendor are not a difference.
    expect(proposeReading(stored(F.TAVERNA, { vendor: 'Taverna Beispiel', gross: 45.3, net: 38.07 }))).toEqual([]);
  });

  it('never proposes to empty a field: a cropped scan keeps the vendor someone typed', () => {
    const changes = proposeReading(stored(F.CROPPED_HEAD, { vendor: 'Cafe Sophie', gross: 32.6, net: 27.39, tip: 2.4 }));
    expect(changes).toEqual([]);
  });

  it('never proposes a total the reader itself could not confirm', () => {
    // A label only, no arithmetic: the stored 450 stays, whatever the reader would take.
    const changes = proposeReading(stored(F.DOLLAR_INVOICE_WITH_DISCOUNT, { vendor: 'Example Courses', gross: 450, net: 378.15, category: 'Sonstige Ausgaben' }));
    expect(changes.map((c) => c.field)).not.toContain('gross');
    expect(changes.map((c) => c.field)).not.toContain('net');
  });

  it('a tip is only offered for a meal', () => {
    const changes = proposeReading(stored(F.ONLINE_ORDER_TAX_INCLUDED, { vendor: 'SHOPIX', gross: 22.42, net: 18.84, category: 'Bürobedarf' }));
    expect(changes).toEqual([]);
  });

  it('a name the old reader built is offered anew with the vendor or total it repeats; a typed name is not', () => {
    const old = stored(F.FOODBAR_TWO_RATES, { name: 'Since 2016 \u2013 Cappuccino \u2013 \u20ac37.70 \u2013 21.03.2025', vendor: 'Since 2016', gross: 37.7, net: 35.14, taxRate: 7 });
    const changes = proposeReading(old);
    expect(changes.map((c) => c.field)).toEqual(['name', 'vendor']);
    expect(String(changes[0].to)).toContain('Fantastic Foodbar');
    expect(String(changes[0].to)).not.toContain('\u2013');

    const typed = proposeReading({ ...old, name: 'Mittagessen mit dem Team' });
    expect(typed.map((c) => c.field)).toEqual(['vendor']);
    // Nothing else changes: the built name stays as it is.
    expect(proposeReading(stored(F.TAVERNA, { name: 'TAVERNA BEISPIEL \u2013 45.30', vendor: 'TAVERNA BEISPIEL', gross: 45.3, net: 38.07 }))).toEqual([]);
  });

  it('no stored text, no proposal', () => {
    expect(proposeReading(stored('', { gross: null }))).toEqual([]);
    expect(proposeReading(stored('   \n'))).toEqual([]);
  });

  it('reading the same text twice gives the same proposal (no model is asked)', () => {
    const receipt = stored(F.GRILL_TOTAL_INCLUDES_TIP, { gross: 48.4, net: 40.67 });
    expect(proposeReading(receipt)).toEqual(proposeReading(receipt));
  });

  it('brings the printed tax groups along when the amounts are confirmed', () => {
    expect(newReading(stored(F.FOODBAR_TWO_RATES)).taxLines).toEqual([
      { rate: 7, net: 34.3, tax: 2.4 },
      { rate: 19, net: 0.84, tax: 0.16 },
    ]);
    expect(newReading(stored(F.DOLLAR_INVOICE_WITH_DISCOUNT)).taxLines).toEqual([]);
  });
});

describe('the offer in the review list', () => {
  const snapshot: ReviewSnapshot = { rowId: 'r1', name: 'x', vendor: 'Lokal', date: '2025-03-14', gross: 50, net: 42.02, taxRate: 19, currency: 'EUR', hasText: true, hasFile: true, fileHashes: [] };

  it('is a reason of its own, and "Geprüft" declines it for good', () => {
    expect(reviewReasons(snapshot, undefined, [], true)).toEqual(['reading_differs']);
    expect(reviewReasons(snapshot, { flags: [], checkedAt: new Date() }, [], true)).toEqual([]);
    expect(reviewReasons(snapshot, undefined, [], false)).toEqual([]);
  });
});
