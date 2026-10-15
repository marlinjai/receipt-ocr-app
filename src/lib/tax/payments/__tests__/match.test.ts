import { describe, expect, it } from 'vitest';
import {
  isValidIban,
  normalizeNumber,
  proposeEstimateMatches,
  proposeMatches,
  referenceMentions,
  unambiguousReferenceMatches,
  vendorNamed,
  type EstimateDocument,
  type EstimatePayment,
  type MatchDocument,
  type MatchPayment,
} from '../match';

const payment = (o: Partial<MatchPayment> & { id: string }): MatchPayment => ({ bookingDay: '2026-03-20', amountCents: 100_000, reference: '', counterparty: 'Kunde Beispiel', ...o });
const document = (o: Partial<MatchDocument> & { id: string }): MatchDocument => ({ number: null, day: '2026-03-01', openCents: 100_000, ...o });

describe('referenceMentions', () => {
  it('finds a number however it is punctuated', () => {
    expect(referenceMentions('Rechnung R-2026-001 vielen Dank', 'R-2026-001')).toBe(true);
    expect(referenceMentions('RE R2026001', 'R-2026-001')).toBe(true);
    expect(referenceMentions('rechnung r 2026 001', 'R-2026/001')).toBe(true);
    expect(normalizeNumber('RE-2026/001')).toBe('re2026001');
  });

  it('does not find a number inside a longer one, a number that is too short, or one without digits', () => {
    expect(referenceMentions('Kundennummer 120260019', '2026001')).toBe(false);
    expect(referenceMentions('Danke fuer die Rechnung', 'Rechnung')).toBe(false);
    expect(referenceMentions('irgendwas', null)).toBe(false);
    expect(referenceMentions('Rechnung 0', '0')).toBe(false);
  });
});

describe('referenceMentions for the plain invoice series (decision D5)', () => {
  it('finds a short number next to an invoice keyword or as the whole text', () => {
    expect(referenceMentions('Rechnung 61', '61')).toBe(true);
    expect(referenceMentions('RE 61', '61')).toBe(true);
    expect(referenceMentions('RE61', '61')).toBe(true);
    expect(referenceMentions('Rechnung-61 Webdesign', '61')).toBe(true);
    expect(referenceMentions('Rechnung Nr. 61, vielen Dank', '61')).toBe(true);
    expect(referenceMentions('Rechnungsnummer 061', '61')).toBe(true);
    expect(referenceMentions('Invoice 7', '7')).toBe(true);
    expect(referenceMentions('61', '61')).toBe(true);
    expect(referenceMentions(' 61 ', '61')).toBe(true);
  });

  it('finds every number of a list after the keyword', () => {
    expect(referenceMentions('Rechnung 61 und 62', '62')).toBe(true);
    expect(referenceMentions('Rechnungen 59 u. 60', '60')).toBe(true);
    expect(referenceMentions('Rechnung 61 und Dank 62', '62')).toBe(false);
  });

  it('never finds invoice 5 inside another figure', () => {
    expect(referenceMentions('Rechnung 52', '5')).toBe(false);
    expect(referenceMentions('RE52', '5')).toBe(false);
    expect(referenceMentions('52', '5')).toBe(false);
    expect(referenceMentions('Rechnung 15', '5')).toBe(false);
    expect(referenceMentions('Rechnung 52 vom 05.10.2026', '5')).toBe(false);
    expect(referenceMentions('Rechnung 5,00 EUR', '5')).toBe(false);
    expect(referenceMentions('Rechnung 5/6', '5')).toBe(false);
  });

  it('never finds a short number inside a date, an amount or an account number', () => {
    expect(referenceMentions('Rechnung vom 12.10.2026', '12')).toBe(false);
    expect(referenceMentions('Rechnung 12.10.2026', '12')).toBe(false);
    expect(referenceMentions('Rechnung 2026-10-12', '12')).toBe(false);
    expect(referenceMentions('Zahlung 61,00 EUR', '61')).toBe(false);
    expect(referenceMentions('DE89 3704 0044 0532 0130 61', '61')).toBe(false);
    expect(referenceMentions('IBAN DE61370400440532013000', '61')).toBe(false);
  });

  it('does not take a bare number without a keyword next to other text', () => {
    expect(referenceMentions('Webdesign 61 Danke', '61')).toBe(false);
    expect(referenceMentions('Kundennr 61', '61')).toBe(false);
  });

  it('takes "Nr" only after an invoice word or at the start, never for a customer, order or tax number', () => {
    expect(referenceMentions('Kunden-Nr. 12', '12')).toBe(false);
    expect(referenceMentions('Kd Nr 12', '12')).toBe(false);
    expect(referenceMentions('Auftrags-Nr 7', '7')).toBe(false);
    expect(referenceMentions('Steuer-Nr. 5', '5')).toBe(false);
    expect(referenceMentions('Mandats-Nr 3', '3')).toBe(false);
    expect(referenceMentions('Rechnung Nr. 61', '61')).toBe(true);
    expect(referenceMentions('Rg.-Nr. 61', '61')).toBe(true);
    expect(referenceMentions('Rechnungs-Nr. 61', '61')).toBe(true);
    expect(referenceMentions('Nr. 61 Webdesign', '61')).toBe(true);
  });

  it('closes the list at a bare second number, and reads a thousands group as part of an amount', () => {
    expect(referenceMentions('Rechnung 61 500 EUR', '500')).toBe(false);
    expect(referenceMentions('Rechnung 1 500,00 EUR', '1')).toBe(false);
    expect(referenceMentions('Rechnung 61 2 Stueck', '2')).toBe(false);
    expect(referenceMentions('RE 61 52', '52')).toBe(false);
    expect(referenceMentions('Re 1 2 3 4', '4')).toBe(false);
  });

  it('names neither invoice of a list written without spaces (the safe side)', () => {
    for (const text of ['Rechnung 61,62', 'Rechnungen 61-62', 'Rechnung 61/62']) {
      expect(referenceMentions(text, '61')).toBe(false);
      expect(referenceMentions(text, '62')).toBe(false);
    }
  });

  it('treats numbers of four and five digits the same way, leading zeros included', () => {
    expect(referenceMentions('Zahlung 12.10.2026', '2026')).toBe(false);
    expect(referenceMentions('Rechnung 12.10.2026', '2026')).toBe(false);
    expect(referenceMentions('Betrag 1.001,00', '1001')).toBe(false);
    expect(referenceMentions('DE89 3704 0044 0532 0130 00', '3704')).toBe(false);
    expect(referenceMentions('10115 Berlin', '10115')).toBe(false);
    expect(referenceMentions('Rechnung 1001', '1001')).toBe(true);
    expect(referenceMentions('Rechnung 61', '0061')).toBe(true);
    expect(referenceMentions('RE 0061', '61')).toBe(true);
  });

  it('finds a long purely numeric number as a whole figure anywhere, but not inside an account number', () => {
    expect(referenceMentions('Beleg 2026001 danke', '2026001')).toBe(true);
    expect(referenceMentions('Beleg 2026-001', '2026001')).toBe(true);
    expect(referenceMentions('Beleg 2026 001', '2026001')).toBe(true);
    expect(referenceMentions('Beleg 2026 0019', '2026001')).toBe(false);
    expect(referenceMentions('IBAN DE89370400440532013000', '370400440532')).toBe(false);
  });

  it('does not take an invoice word glued into an account-like text for an account number', () => {
    expect(referenceMentions('RE61 Webdesignleistungen Oktober', '61')).toBe(true);
    // Shaped like an IBAN, but its check digits are wrong: it is invoice 61 and other figures.
    expect(isValidIban('RE61 1234 5678 9012')).toBe(false);
    expect(referenceMentions('RE61 1234 5678 9012', '61')).toBe(true);
    expect(isValidIban('DE89 3704 0044 0532 0130 00')).toBe(true);
  });

  it('tells an invoice number followed by the amount from an amount written with a space, by the payment amount', () => {
    expect(referenceMentions('Rechnung 61 150,00 EUR', '61', 15_000)).toBe(true);
    expect(referenceMentions('RE 61 250,00', '61', -25_000)).toBe(true);
    expect(referenceMentions('Rechnung 61 500 EUR', '61', 50_000)).toBe(true);
    expect(referenceMentions('Rechnung 1 500,00 EUR', '1', 150_000)).toBe(false);
    expect(referenceMentions('Rechnung 1 500 EUR', '1', 150_000)).toBe(false);
    // Without the payment's amount it stays on the safe side.
    expect(referenceMentions('Rechnung 61 150,00 EUR', '61')).toBe(false);
  });

  it('continues a list after a comma, a plus or an ampersand, never after a bare space', () => {
    expect(referenceMentions('Rechnung 61, 62', '62')).toBe(true);
    expect(referenceMentions('Rechnung 61 + 62', '62')).toBe(true);
    expect(referenceMentions('Rechnungen 61 & 62', '62')).toBe(true);
    expect(referenceMentions('Rechnung 61 62', '62')).toBe(false);
  });

  it('reads a long number only as a whole run of figures, and a date never as a number', () => {
    expect(referenceMentions('Tel 030 2026001', '2026001')).toBe(false);
    expect(referenceMentions('Kunde 9 123 4567', '1234567')).toBe(false);
    // Groups spelled with spaces that make up the whole run are the number ("2026 001"), so "123 4567" is 1234567.
    expect(referenceMentions('Kunde 123 4567', '1234567')).toBe(true);
    expect(referenceMentions('Datum 2026-10-01', '20261001')).toBe(false);
    expect(referenceMentions('Beleg 2026001, danke', '2026001')).toBe(true);
  });

  it('never counts a number with letters that is shorter than four characters', () => {
    expect(referenceMentions('Rechnung RE-5', 'RE-5')).toBe(false);
  });

  it('links a payment that names its invoice to that invoice only, not to one whose number is inside it', () => {
    const proposals = proposeMatches(
      [payment({ id: 'p', reference: 'Rechnung 52', amountCents: 50_000 })],
      [document({ id: 'five', number: '5', openCents: 50_000 }), document({ id: 'fiftytwo', number: '52', openCents: 50_000 })],
    );
    expect(unambiguousReferenceMatches(proposals)).toEqual([{ paymentId: 'p', documentId: 'fiftytwo', strength: 'reference' }]);
  });
});

describe('proposeMatches', () => {
  it('links on the reference when the amount fits', () => {
    const proposals = proposeMatches([payment({ id: 'p', reference: 'Rechnung R-2026-001' })], [document({ id: 'd', number: 'R-2026-001' })]);
    expect(proposals).toEqual([{ paymentId: 'p', documentId: 'd', strength: 'reference' }]);
    expect(unambiguousReferenceMatches(proposals)).toEqual(proposals);
  });

  it('a reference with another amount is proposed but never linked on its own', () => {
    const proposals = proposeMatches([payment({ id: 'p', reference: 'R-2026-001', amountCents: 99_000 })], [document({ id: 'd', number: 'R-2026-001' })]);
    expect(proposals).toEqual([{ paymentId: 'p', documentId: 'd', strength: 'reference_amount_differs' }]);
    expect(unambiguousReferenceMatches(proposals)).toEqual([]);
  });

  it('amount and date alone give a candidate, only inside the window, and never an automatic link', () => {
    const docs = [document({ id: 'd' })];
    const inside = proposeMatches([payment({ id: 'p' })], docs);
    expect(inside).toEqual([{ paymentId: 'p', documentId: 'd', strength: 'amount_and_date' }]);
    expect(unambiguousReferenceMatches(inside)).toEqual([]);
    expect(proposeMatches([payment({ id: 'p', bookingDay: '2026-02-20' })], docs)).toEqual([]);
    expect(proposeMatches([payment({ id: 'p', bookingDay: '2026-05-15' })], docs)).toEqual([]);
    expect(proposeMatches([payment({ id: 'p', amountCents: 100_001 })], docs)).toEqual([]);
    expect(proposeMatches([payment({ id: 'p' })], [document({ id: 'd', day: null })])).toEqual([]);
  });

  it('a payment or document with a reference match gets no amount candidates on top', () => {
    const proposals = proposeMatches(
      [payment({ id: 'p1', reference: 'R-2026-001' }), payment({ id: 'p2' })],
      [document({ id: 'd1', number: 'R-2026-001' }), document({ id: 'd2' })],
    );
    expect(proposals).toEqual([
      { paymentId: 'p1', documentId: 'd1', strength: 'reference' },
      { paymentId: 'p2', documentId: 'd2', strength: 'amount_and_date' },
    ]);
  });

  it('one payment naming two invoices, or two payments naming one, is not linked without a person', () => {
    const twoDocs = proposeMatches(
      [payment({ id: 'p', reference: 'R-2026-001 und R-2026-002' })],
      [document({ id: 'd1', number: 'R-2026-001' }), document({ id: 'd2', number: 'R-2026-002', openCents: 50_000 })],
    );
    expect(twoDocs.map((p) => p.strength)).toEqual(['reference', 'reference_amount_differs']);
    expect(unambiguousReferenceMatches(twoDocs)).toEqual([]);
    const twoPayments = proposeMatches(
      [payment({ id: 'p1', reference: 'R-2026-001' }), payment({ id: 'p2', reference: 'R-2026-001', bookingDay: '2026-03-21' })],
      [document({ id: 'd', number: 'R-2026-001' })],
    );
    expect(unambiguousReferenceMatches(twoPayments)).toEqual([]);
  });

  it('a document with nothing open is left alone, and money out matches by its magnitude', () => {
    expect(proposeMatches([payment({ id: 'p', reference: 'R-2026-001' })], [document({ id: 'd', number: 'R-2026-001', openCents: 0 })])).toEqual([]);
    expect(proposeMatches([payment({ id: 'p', amountCents: -100_000 })], [document({ id: 'd' })])).toEqual([{ paymentId: 'p', documentId: 'd', strength: 'amount_and_date' }]);
  });
});

describe('proposals for receipts on an estimated euro amount', () => {
  // A dollar receipt of 2 March estimated at 20.00 euro, and the charge for it.
  const receipt = (o: Partial<EstimateDocument> & { id: string }): EstimateDocument => ({ vendorKey: 'editor beispiel', day: '2025-03-02', amountCents: 2000, estimated: true, ...o });
  const paid = (o: Partial<EstimatePayment> & { id: string }): EstimatePayment => ({ bookingDay: '2025-03-03', amountCents: -2075, counterpartyKey: 'editor beispiel', referenceKey: '', ...o });

  it('proposes the one payment to the same vendor near the receipt and near the estimate', () => {
    expect(proposeEstimateMatches([paid({ id: 'p1' })], [receipt({ id: 'r1' })])).toEqual([{ paymentId: 'p1', documentId: 'r1', unambiguous: true, severalReceipts: false }]);
  });

  it('the window is 3 days before to 10 days after the receipt, both ends included', () => {
    const days = (bookingDay: string) => proposeEstimateMatches([paid({ id: 'p1', bookingDay })], [receipt({ id: 'r1' })]).length;
    expect([days('2025-02-26'), days('2025-02-27'), days('2025-03-12'), days('2025-03-13')]).toEqual([0, 1, 1, 0]);
  });

  it('the amount may be 8 percent off the estimate, both ways, and not a cent more', () => {
    const cents = (amountCents: number) => proposeEstimateMatches([paid({ id: 'p1', amountCents })], [receipt({ id: 'r1' })]).length;
    expect([cents(-1839), cents(-1840), cents(-2160), cents(-2161)]).toEqual([0, 1, 1, 0]);
  });

  it('the vendor has to be named: in the counterparty, in the text, or the counterparty in the vendor', () => {
    expect(vendorNamed('editor beispiel', 'editor beispiel ai powered', '')).toBe(true);
    expect(vendorNamed('editor beispiel', 'kartenzahlung', 'abo editor beispiel maerz')).toBe(true);
    expect(vendorNamed('notizen beispiel labs', 'notizen beispiel', '')).toBe(true);
    // Whole words only, and a counterparty of two letters says nothing.
    expect(vendorNamed('editor', 'editorial verlag', '')).toBe(false);
    expect(vendorNamed('ab beispiel', 'ab', '')).toBe(false);
    expect(vendorNamed(null, 'editor beispiel', '')).toBe(false);
    expect(proposeEstimateMatches([paid({ id: 'p1', counterpartyKey: 'anderer laden' })], [receipt({ id: 'r1' })])).toEqual([]);
  });

  it('two payments for one receipt are both offered and neither is unambiguous', () => {
    const proposals = proposeEstimateMatches([paid({ id: 'p1' }), paid({ id: 'p2', bookingDay: '2025-03-06', amountCents: -1990 })], [receipt({ id: 'r1' })]);
    expect(proposals).toEqual([
      { paymentId: 'p1', documentId: 'r1', unambiguous: false, severalReceipts: false },
      { paymentId: 'p2', documentId: 'r1', unambiguous: false, severalReceipts: false },
    ]);
  });

  it('a payment that fits two receipts is unambiguous for neither', () => {
    const proposals = proposeEstimateMatches([paid({ id: 'p1' })], [receipt({ id: 'r1' }), receipt({ id: 'r2', day: '2025-03-04', amountCents: 2100 })]);
    expect(proposals.map((p) => [p.documentId, p.unambiguous])).toEqual([['r1', false], ['r2', false]]);
  });

  it('a euro receipt gets no proposal, but its exact amount makes the payment ambiguous for the estimated one', () => {
    const euro = receipt({ id: 'r-euro', estimated: false, amountCents: 2075 });
    expect(proposeEstimateMatches([paid({ id: 'p1' })], [euro])).toEqual([]);
    expect(proposeEstimateMatches([paid({ id: 'p1' })], [receipt({ id: 'r1' }), euro])).toEqual([{ paymentId: 'p1', documentId: 'r1', unambiguous: false, severalReceipts: false }]);
    // A euro receipt of another amount is no fit: the estimated receipt stays unambiguous.
    expect(proposeEstimateMatches([paid({ id: 'p1' })], [receipt({ id: 'r1' }), { ...euro, amountCents: 2076 }])).toEqual([{ paymentId: 'p1', documentId: 'r1', unambiguous: true, severalReceipts: false }]);
  });

  it('a monthly subscription pairs each receipt with its own month', () => {
    const proposals = proposeEstimateMatches(
      [paid({ id: 'p-mar' }), paid({ id: 'p-apr', bookingDay: '2025-04-03', amountCents: -1988 })],
      [receipt({ id: 'r-mar' }), receipt({ id: 'r-apr', day: '2025-04-02' })],
    );
    expect(proposals).toEqual([
      { paymentId: 'p-mar', documentId: 'r-mar', unambiguous: true, severalReceipts: false },
      { paymentId: 'p-apr', documentId: 'r-apr', unambiguous: true, severalReceipts: false },
    ]);
  });

  it('one payment for two receipts: when the sum of two fits better than one alone, both are offered as needing a hand', () => {
    // Two invoices of one vendor, 19.00 and 0.50 estimated, charged together as 19.48.
    const big = receipt({ id: 'r-big', amountCents: 1900 });
    const small = receipt({ id: 'r-small', amountCents: 50, day: '2025-03-03' });
    const sum = proposeEstimateMatches([paid({ id: 'p1', amountCents: -1948 })], [big, small]);
    // The large one fits alone too (2.5 percent off), which is how it came to be proposed in full: no longer unambiguous.
    expect(sum).toEqual([
      { paymentId: 'p1', documentId: 'r-big', unambiguous: false, severalReceipts: true },
      { paymentId: 'p1', documentId: 'r-small', unambiguous: false, severalReceipts: true },
    ]);
    // Two halves, neither of which fits alone, are found as well.
    const halves = proposeEstimateMatches([paid({ id: 'p1', amountCents: -1948 })], [receipt({ id: 'r-a', amountCents: 1000 }), receipt({ id: 'r-b', amountCents: 950 })]);
    expect(halves.map((p) => [p.documentId, p.unambiguous, p.severalReceipts])).toEqual([['r-a', false, true], ['r-b', false, true]]);
    // The exact single fit wins over a sum that is further off: an ordinary unambiguous proposal for the one, nothing for the other.
    expect(proposeEstimateMatches([paid({ id: 'p1', amountCents: -1900 })], [big, small])).toEqual([{ paymentId: 'p1', documentId: 'r-big', unambiguous: true, severalReceipts: false }]);
    // A second receipt of another vendor, or outside the window, is no part of the sum.
    expect(proposeEstimateMatches([paid({ id: 'p1', amountCents: -1948 })], [big, { ...small, vendorKey: 'anderer laden' }])[0]).toMatchObject({ unambiguous: true, severalReceipts: false });
    expect(proposeEstimateMatches([paid({ id: 'p1', amountCents: -1948 })], [big, { ...small, day: '2025-01-03' }])[0]).toMatchObject({ unambiguous: true, severalReceipts: false });
  });

  it('a counterparty a person linked to a vendor before stands for that vendor, whatever the names say', () => {
    // The list names the product, the invoice the company behind it.
    const product = paid({ id: 'p1', counterpartyKey: 'schreibwerk', referenceKey: 'schreibwerk pro' });
    const invoice = receipt({ id: 'r1', vendorKey: 'beispiel software' });
    expect(proposeEstimateMatches([product], [invoice])).toEqual([]);
    expect(proposeEstimateMatches([{ ...product, vendorAliases: ['beispiel software'] }], [invoice])).toEqual([{ paymentId: 'p1', documentId: 'r1', unambiguous: true, severalReceipts: false }]);
    // The pairing is for that vendor only, and window and amount still have to fit.
    expect(proposeEstimateMatches([{ ...product, vendorAliases: ['anderer laden'] }], [invoice])).toEqual([]);
    expect(proposeEstimateMatches([{ ...product, vendorAliases: ['beispiel software'], amountCents: -9000 }], [invoice])).toEqual([]);
  });

  it('a receipt without a vendor, a day or an amount gets nothing', () => {
    const none = [receipt({ id: 'r1', vendorKey: null }), receipt({ id: 'r2', day: null }), receipt({ id: 'r3', amountCents: 0 })];
    expect(proposeEstimateMatches([paid({ id: 'p1' })], none)).toEqual([]);
  });
});
