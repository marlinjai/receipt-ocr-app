import { describe, expect, it } from 'vitest';
import { classifyPayLater, knownPayLaterMethod, looksLikeCardText, resolvePayLaterDays, type TaxDayCollection, type TaxDayPurchase } from '../tax-day';
import type { PayLaterDetail } from '../types';

// Every number, name and amount is invented.
const detail = (o: Partial<PayLaterDetail> = {}): PayLaterDetail => ({ method: 'Invoice', card: false, statement: '7ABCDEFG', reference: null, ...o });
const purchase = (o: Partial<TaxDayPurchase> & { id: string }): TaxDayPurchase => ({
  bookingDay: '2025-12-10',
  valueDay: null,
  amountCents: -1_000,
  counterparty: 'Laden Beispiel',
  detail: detail(),
  override: null,
  ...o,
});
const collection = (o: Partial<TaxDayCollection> & { id: string }): TaxDayCollection => ({ bookingDay: '2026-01-15', amountCents: -1_000, text: 'Klarna Bank AB Lastschrift', ...o });

describe('how a pay-later purchase was paid', () => {
  it('reads the wordings the list carries', () => {
    expect(knownPayLaterMethod('Cards')).toBe('card');
    expect(knownPayLaterMethod('Term Loan')).toBe('financed');
    expect(knownPayLaterMethod('Direct Debit')).toBe('direct_debit');
    expect(knownPayLaterMethod('Invoice')).toBe('checkout');
    expect(knownPayLaterMethod('In 30 Tagen zahlen')).toBe('checkout');
    expect(knownPayLaterMethod('in 14  Tagen zahlen')).toBe('checkout');
    expect(knownPayLaterMethod('Flexible Amount')).toBeNull();
    expect(knownPayLaterMethod('')).toBeNull();
  });

  it('a card marker wins over the wording: card purchases carry "Invoice" too', () => {
    expect(classifyPayLater(detail({ card: true }), 'Laden Beispiel')).toBe('card');
    expect(classifyPayLater(detail(), 'ZAHLDIENST *Laden Beispiel')).toBe('card');
    expect(classifyPayLater(detail({ method: 'Cards' }), 'Laden Beispiel')).toBe('card');
    expect(classifyPayLater(detail({ method: 'Term Loan' }), 'Laden Beispiel')).toBe('financed');
    expect(classifyPayLater(detail({ method: 'Direct Debit' }), 'Laden Beispiel')).toBe('direct_debit');
    expect(classifyPayLater(detail(), 'Laden Beispiel')).toBe('checkout');
  });

  it('reads an unknown wording as checkout, the cautious reading', () => {
    expect(classifyPayLater(detail({ method: 'Direct Bank Transfer' }), 'Laden Beispiel')).toBe('checkout');
    expect(classifyPayLater(detail({ method: '' }), 'Laden Beispiel')).toBe('checkout');
  });

  it('knows the card network form only with a name on both sides of the star', () => {
    expect(looksLikeCardText('ZAHLDIENST *Laden')).toBe(true);
    expect(looksLikeCardText('SQ * Café')).toBe(true);
    expect(looksLikeCardText('Laden *')).toBe(false);
    expect(looksLikeCardText('* Laden')).toBe(false);
    expect(looksLikeCardText('Laden Beispiel')).toBe(false);
  });
});

describe('the day a pay-later purchase counts on', () => {
  it('a checkout purchase counts on the day of the collection of exactly its statement sum, card purchases of the statement included', () => {
    const days = resolvePayLaterDays(
      [
        purchase({ id: 'checkout', bookingDay: '2025-12-10', amountCents: -1_000 }),
        purchase({ id: 'card', bookingDay: '2025-12-12', amountCents: -2_500, detail: detail({ card: true }) }),
      ],
      [collection({ id: 'early', bookingDay: '2025-12-11', amountCents: -3_500 }), collection({ id: 'jan', bookingDay: '2026-01-15', amountCents: -3_500 })],
    );
    // The collection of the 11th is before the statement's last purchase: it cannot settle it.
    expect(days.get('checkout')).toEqual({ method: 'checkout', byPerson: false, taxDay: '2026-01-15', collectionId: 'jan', matchedBy: 'amount', dayUnknown: false });
    expect(days.get('card')).toEqual({ method: 'card', byPerson: false, taxDay: '2025-12-12', collectionId: null, matchedBy: null, dayUnknown: false });
  });

  it('a financed purchase counts on its purchase day, a direct debit on its capture day', () => {
    const days = resolvePayLaterDays(
      [
        purchase({ id: 'loan', detail: detail({ method: 'Term Loan', statement: null }) }),
        purchase({ id: 'debit', valueDay: '2025-12-12', detail: detail({ method: 'Direct Debit', statement: null }) }),
        purchase({ id: 'debit-no-capture', detail: detail({ method: 'Direct Debit', statement: null }) }),
      ],
      [collection({ id: 'c' })],
    );
    expect(days.get('loan')?.taxDay).toBe('2025-12-10');
    expect(days.get('debit')?.taxDay).toBe('2025-12-12');
    expect(days.get('debit-no-capture')?.taxDay).toBe('2025-12-10');
  });

  it('matches by the statement number in the collection text before any amount', () => {
    const days = resolvePayLaterDays(
      [purchase({ id: 'a', amountCents: -1_000 }), purchase({ id: 'b', amountCents: -500, detail: detail({ statement: '9ZYXWVUT' }) })],
      [collection({ id: 'same-sum', bookingDay: '2026-01-02', amountCents: -1_000 }), collection({ id: 'named', bookingDay: '2026-01-20', amountCents: -999, text: 'Klarna Abrechnung 7ABCDEFG' })],
    );
    expect(days.get('a')).toMatchObject({ taxDay: '2026-01-20', collectionId: 'named', matchedBy: 'statement' });
    // The other statement finds nothing of its sum.
    expect(days.get('b')).toMatchObject({ taxDay: '2025-12-10', dayUnknown: true });
  });

  it('a collection naming the purchase settles that purchase alone; the rest of the statement adds up without it', () => {
    const days = resolvePayLaterDays(
      [purchase({ id: 'by-number', amountCents: -400, detail: detail({ reference: '1000000000009' }) }), purchase({ id: 'rest', amountCents: -600 })],
      [collection({ id: 'transfer', bookingDay: '2025-12-20', amountCents: -400, text: 'Klarna 1000000000009' }), collection({ id: 'rest-collection', bookingDay: '2026-01-15', amountCents: -600 })],
    );
    expect(days.get('by-number')).toMatchObject({ taxDay: '2025-12-20', matchedBy: 'reference' });
    expect(days.get('rest')).toMatchObject({ taxDay: '2026-01-15', matchedBy: 'amount' });
  });

  it('each collection settles one statement, statements in the order of their last purchase', () => {
    const days = resolvePayLaterDays(
      [purchase({ id: 'nov', bookingDay: '2025-11-05', detail: detail({ statement: 'NOV00001' }) }), purchase({ id: 'dec', bookingDay: '2025-12-05', detail: detail({ statement: 'DEC00001' }) })],
      [collection({ id: 'c1', bookingDay: '2025-12-01' }), collection({ id: 'c2', bookingDay: '2026-01-02' })],
    );
    expect(days.get('nov')?.collectionId).toBe('c1');
    expect(days.get('dec')?.collectionId).toBe('c2');
  });

  it('without a collection a checkout purchase stays on its purchase day, marked unknown; a purchase without a statement too', () => {
    const days = resolvePayLaterDays([purchase({ id: 'a' }), purchase({ id: 'b', detail: detail({ statement: null }) })], []);
    expect(days.get('a')).toMatchObject({ taxDay: '2025-12-10', dayUnknown: true, method: 'checkout' });
    expect(days.get('b')).toMatchObject({ taxDay: '2025-12-10', dayUnknown: true });
  });

  it('a person says how one purchase was paid, both ways', () => {
    const collections = [collection({ id: 'c', amountCents: -2_000 })];
    const both = (override: 'card' | 'checkout' | null, cardMarked: boolean) =>
      resolvePayLaterDays([purchase({ id: 'x', override, detail: detail({ card: cardMarked }) }), purchase({ id: 'y' })], collections).get('x');
    expect(both('card', false)).toMatchObject({ method: 'card', byPerson: true, taxDay: '2025-12-10' });
    expect(both('checkout', true)).toMatchObject({ method: 'checkout', byPerson: true, taxDay: '2026-01-15' });
    // Taken back: what the list says again.
    expect(both(null, false)).toMatchObject({ method: 'checkout', byPerson: false, taxDay: '2026-01-15' });
    expect(both(null, true)).toMatchObject({ method: 'card', byPerson: false, taxDay: '2025-12-10' });
  });

  it('a purchase imported before the details were kept stays on its purchase day, unless its text shows the card', () => {
    const days = resolvePayLaterDays(
      [purchase({ id: 'old', detail: null }), purchase({ id: 'old-card', detail: null, counterparty: 'ZAHLDIENST *Laden' })],
      [collection({ id: 'c', amountCents: -1_000 })],
    );
    expect(days.get('old')).toEqual({ method: null, byPerson: false, taxDay: '2025-12-10', collectionId: null, matchedBy: null, dayUnknown: false });
    expect(days.get('old-card')?.method).toBe('card');
  });

  it('pairs the same way whatever order the payments come in', () => {
    const purchases = [purchase({ id: 'a', detail: detail({ statement: 'S1' }) }), purchase({ id: 'b', detail: detail({ statement: 'S2' }) })];
    const collections = [collection({ id: 'c2', bookingDay: '2026-01-20' }), collection({ id: 'c1', bookingDay: '2026-01-10' })];
    const forward = resolvePayLaterDays(purchases, collections);
    const backward = resolvePayLaterDays([...purchases].reverse(), [...collections].reverse());
    expect([...backward.entries()].sort()).toEqual([...forward.entries()].sort());
    expect(forward.get('a')?.collectionId).toBe('c1');
  });
});
