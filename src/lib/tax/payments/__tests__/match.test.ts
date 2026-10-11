import { describe, expect, it } from 'vitest';
import {
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
    expect(referenceMentions('Rechnung 42', '42')).toBe(false);
    expect(referenceMentions('Danke fuer die Rechnung', 'Rechnung')).toBe(false);
    expect(referenceMentions('irgendwas', null)).toBe(false);
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
    expect(proposeEstimateMatches([paid({ id: 'p1' })], [receipt({ id: 'r1' })])).toEqual([{ paymentId: 'p1', documentId: 'r1', unambiguous: true }]);
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
      { paymentId: 'p1', documentId: 'r1', unambiguous: false },
      { paymentId: 'p2', documentId: 'r1', unambiguous: false },
    ]);
  });

  it('a payment that fits two receipts is unambiguous for neither', () => {
    const proposals = proposeEstimateMatches([paid({ id: 'p1' })], [receipt({ id: 'r1' }), receipt({ id: 'r2', day: '2025-03-04', amountCents: 2100 })]);
    expect(proposals.map((p) => [p.documentId, p.unambiguous])).toEqual([['r1', false], ['r2', false]]);
  });

  it('a euro receipt gets no proposal, but its exact amount makes the payment ambiguous for the estimated one', () => {
    const euro = receipt({ id: 'r-euro', estimated: false, amountCents: 2075 });
    expect(proposeEstimateMatches([paid({ id: 'p1' })], [euro])).toEqual([]);
    expect(proposeEstimateMatches([paid({ id: 'p1' })], [receipt({ id: 'r1' }), euro])).toEqual([{ paymentId: 'p1', documentId: 'r1', unambiguous: false }]);
    // A euro receipt of another amount is no fit: the estimated receipt stays unambiguous.
    expect(proposeEstimateMatches([paid({ id: 'p1' })], [receipt({ id: 'r1' }), { ...euro, amountCents: 2076 }])).toEqual([{ paymentId: 'p1', documentId: 'r1', unambiguous: true }]);
  });

  it('a monthly subscription pairs each receipt with its own month', () => {
    const proposals = proposeEstimateMatches(
      [paid({ id: 'p-mar' }), paid({ id: 'p-apr', bookingDay: '2025-04-03', amountCents: -1988 })],
      [receipt({ id: 'r-mar' }), receipt({ id: 'r-apr', day: '2025-04-02' })],
    );
    expect(proposals).toEqual([
      { paymentId: 'p-mar', documentId: 'r-mar', unambiguous: true },
      { paymentId: 'p-apr', documentId: 'r-apr', unambiguous: true },
    ]);
  });

  it('a receipt without a vendor, a day or an amount gets nothing', () => {
    const none = [receipt({ id: 'r1', vendorKey: null }), receipt({ id: 'r2', day: null }), receipt({ id: 'r3', amountCents: 0 })];
    expect(proposeEstimateMatches([paid({ id: 'p1' })], none)).toEqual([]);
  });
});
