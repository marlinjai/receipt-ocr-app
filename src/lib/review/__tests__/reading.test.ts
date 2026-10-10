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
  currency: 'EUR',
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
    // A label only, no arithmetic: the stored 75 stays, whatever the reader would take.
    const changes = proposeReading(stored(F.PARKING_LABEL_ONLY, { vendor: 'Parkhaus Beispiel', gross: 75, net: 63.03, category: 'Reisekosten' }));
    expect(changes).toEqual([]);
    // Nor an estimated rate over a stored one: the total is confirmed here (30,00 less 5,00), the 19 percent are a default.
    const estimated = proposeReading(stored('Laden Beispiel GmbH\nZwischensumme 30,00\nRabatt -5,00\nSumme 25,00', { vendor: 'Laden Beispiel GmbH', gross: 30, net: 28.04, taxRate: 7, category: 'Sonstige Ausgaben' }));
    expect(estimated).toEqual([]);
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

/**
 * The course invoice of 2026-10-10: stored by the old reader as 450 with an
 * empty currency (which the app reads as euros), a euro sign in its name and
 * 19 percent German tax. 360 dollars were paid.
 */
describe('the currency of a new reading', () => {
  const oldName = 'Example Courses \u2013 Premium Package \u2013 \u20ac450.00 \u2013 26.11.2025';
  const oldDollarInvoice = (overrides: Partial<StoredReading> = {}) =>
    stored(F.DOLLAR_INVOICE_WITH_DISCOUNT, { name: oldName, vendor: 'Example Courses', gross: 450, net: 378.15, taxRate: 19, currency: null, category: 'Sonstige Ausgaben', ...overrides });

  it('a dollar invoice stored in euros: total, net, rate and currency are offered together, and the name that repeats them', () => {
    expect(byField(proposeReading(oldDollarInvoice()))).toEqual({
      name: [oldName, 'Example Courses, 360.00 USD, 26.11.2025'],
      gross: [450, 360],
      net: [378.15, 360],
      taxRate: [19, 0],
      currency: [null, 'USD'],
    });
  });

  it('an empty currency is euros: it differs from dollars and not from euros', () => {
    expect(proposeReading(oldDollarInvoice()).map((c) => c.field)).toContain('currency');
    // A euro receipt of the old reader, its currency never filled in: nothing to offer.
    expect(proposeReading(stored(F.TAVERNA, { vendor: 'TAVERNA BEISPIEL', gross: 45.3, net: 38.07, currency: null }))).toEqual([]);
  });

  it('a stored currency the reader agrees with is left alone', () => {
    expect(proposeReading(oldDollarInvoice({ name: 'Kurs Webentwicklung', gross: 360, net: 360, taxRate: 0, currency: 'USD' }))).toEqual([]);
  });

  it('a stored currency the receipt contradicts is offered, also where the total cannot be confirmed', () => {
    const changes = proposeReading(stored('Shop Inc\nTotal: $50.00', { vendor: 'Shop Inc', gross: 50, net: 42.02, currency: 'EUR', category: 'Sonstige Ausgaben' }));
    // The total is a label alone, so the amounts stay; the dollar sign is on the receipt all the same.
    expect(changes).toEqual([{ field: 'currency', from: 'EUR', to: 'USD' }]);
  });

  it('the euro the reader only assumes is never offered over a stored currency', () => {
    const noSign = 'Laden Beispiel GmbH\nSumme 25,00\nNetto 21,01\nMwSt 19% 3,99';
    expect(proposeReading(stored(noSign, { vendor: 'Laden Beispiel GmbH', gross: 25, net: 21.01, currency: 'USD', category: 'Sonstige Ausgaben' }))).toEqual([]);
  });

  it('a stored currency under a name the reader does not know is left as it is', () => {
    // The euro option renamed to "Euro": the receipt is in euros all the same, and its amounts are still offered.
    const changes = proposeReading(stored(F.THAI_TOTAL_TIP_GRAND_TOTAL, { vendor: 'Bangkok Garten', gross: 50, net: 42.02, currency: 'Euro' }));
    expect(changes.map((c) => c.field)).toEqual(['gross', 'net', 'tip']);
  });

  it('a majority among mixed currency signs is a guess, not a reading', () => {
    const mixed = 'Laden Beispiel GmbH\nUS$ Adapter\nSumme 25,00 €\nNetto 21,01\nMwSt 19% 3,99';
    expect(proposeReading(stored(mixed, { vendor: 'Laden Beispiel GmbH', gross: 25, net: 21.01, currency: null, category: 'Sonstige Ausgaben' }))).toEqual([]);
  });

  it('a name the old reader built is offered anew when only the currency changes; a typed name is not', () => {
    const totalRight = { gross: 360, net: 360, taxRate: 0 };
    expect(proposeReading(oldDollarInvoice(totalRight)).map((c) => c.field)).toEqual(['name', 'currency']);
    expect(proposeReading(oldDollarInvoice({ ...totalRight, name: 'Kurs Webentwicklung' })).map((c) => c.field)).toEqual(['currency']);
  });

  it('a foreign receipt that states its tax is offered what it states', () => {
    const changes = proposeReading(stored(F.DOLLAR_INVOICE_WITH_TAX, { vendor: 'Example Courses', gross: 450, net: 378.15, taxRate: 19, currency: 'USD', category: 'Sonstige Ausgaben' }));
    expect(byField(changes)).toEqual({ gross: [450, 428.4], net: [378.15, 360] });
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
