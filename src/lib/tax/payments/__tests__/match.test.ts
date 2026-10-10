import { describe, expect, it } from 'vitest';
import { normalizeNumber, proposeMatches, referenceMentions, unambiguousReferenceMatches, type MatchDocument, type MatchPayment } from '../match';

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
