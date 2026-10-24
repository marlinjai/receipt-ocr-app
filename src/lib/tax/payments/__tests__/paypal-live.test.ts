import { describe, expect, it } from 'vitest';
import { matchStored, sourcesMayShare } from '../coverage';
import { scaleLinks } from '../estimate';
import { ESTIMATE_TOLERANCE_PERCENT, heldService, resolveFunding, serviceOfInstitution, type FundingPayment } from '../funding';
import { parsePaymentFile, rateKey, referenceHash, walletRateNeeds } from '../parse';


/**
 * PayPal continued live through the bank interface (plan 2026-10-23): the
 * reader of the wallet's list, the funding rule and the comparison of edge
 * days. Every name, code and amount is invented; the field shapes are the ones
 * PayPal gives over the interface (no booking or value date, no remittance text).
 */

type Tx = Record<string, unknown>;
const tx = (o: { day: string; cents: number; currency?: string; party?: string; code?: string; status?: string }): Tx => ({
  status: o.status ?? 'BOOK',
  transaction_date: o.day,
  transaction_amount: { amount: (Math.abs(o.cents) / 100).toFixed(2), currency: o.currency ?? 'EUR' },
  credit_debit_indicator: o.cents < 0 ? 'DBIT' : 'CRDT',
  bank_transaction_code: { description: 'invented' },
  ...(o.party === undefined ? {} : o.cents < 0 ? { creditor: { name: o.party } } : { debtor: { name: o.party } }),
  ...(o.code === undefined ? {} : { entry_reference: o.code }),
});
const list = (...rows: Tx[]) => JSON.stringify({ transactions: rows });
const rates = (entries: Record<string, number>) => ({ wallet: { rates: new Map(Object.entries(entries)) } });

describe('the bank interface list of a PayPal wallet', () => {
  it('reads a dollar purchase at the reference rate of its day, keeps the dollars and marks the euro amount as an estimate', () => {
    const file = parsePaymentFile(list(tx({ day: '2026-10-02', cents: -1000, currency: 'USD', party: 'Hosting Beispiel', code: 'PP-1' })), rates({ [rateKey('USD', '2026-10-02')]: 0.9123 }));
    expect(file.payments).toHaveLength(1);
    expect(file.payments[0]).toMatchObject({ bookingDay: '2026-10-02', amountCents: -912, original: { currency: 'USD', amountCents: -1000 }, estimated: true, counterparty: 'Hosting Beispiel', kind: 'spend' });
  });

  it('a movement whose rate is missing is left out and counted, never read at a guessed rate', () => {
    const file = parsePaymentFile(list(tx({ day: '2026-10-02', cents: -1000, currency: 'XYZ', party: 'Laden Beispiel', code: 'PP-2' }), tx({ day: '2026-10-03', cents: -500, party: 'Kiosk Beispiel', code: 'PP-3' })), rates({}));
    expect(file.payments.map((p) => p.entryReference)).toEqual(['PP-3']);
    expect(file.skipped).toEqual({ no_exchange_rate: 1 });
  });

  it('a wallet movement without a readable currency is an unreadable row, never left out in silence', () => {
    const odd = { ...tx({ day: '2026-10-02', cents: -1000, party: 'Laden Beispiel', code: 'PP-2' }), transaction_amount: { amount: '10.00', currency: 'usd' } };
    expect(() => parsePaymentFile(list(odd), rates({}))).toThrow(expect.objectContaining({ code: 'unreadable_row', row: 1 }));
  });

  it('a bank list (no wallet) still leaves every other currency out, as before', () => {
    const file = parsePaymentFile(list(tx({ day: '2026-10-02', cents: -1000, currency: 'USD', party: 'Hosting Beispiel', code: 'PP-1' }), tx({ day: '2026-10-03', cents: -500, party: 'Kiosk Beispiel' })));
    expect(file.skipped).toEqual({ other_currency: 1 });
    expect(file.payments.every((p) => !p.estimated && !p.original)).toBe(true);
  });

  it('rejected movements are counted apart from the ones not booked yet', () => {
    const file = parsePaymentFile(list(tx({ day: '2026-10-02', cents: -1000, party: 'A', code: 'R1', status: 'RJCT' }), tx({ day: '2026-10-02', cents: -1000, party: 'A', code: 'R2', status: 'PDNG' }), tx({ day: '2026-10-03', cents: -100, party: 'B', code: 'R3' })), rates({}));
    expect(file.skipped).toEqual({ rejected: 1, not_booked: 1 });
  });

  it("PayPal's code is the identity of a row whose code no other row repeats; the others keep the content identity", () => {
    const file = parsePaymentFile(
      list(tx({ day: '2026-10-02', cents: -1000, party: 'A', code: 'C1' }), tx({ day: '2026-10-02', cents: -200, party: 'B', code: 'DUP' }), tx({ day: '2026-10-03', cents: -300, party: 'C', code: 'DUP' }), tx({ day: '2026-10-04', cents: 400, party: 'D' })),
      rates({}),
    );
    const [unique, dupA, dupB, none] = file.payments;
    expect(unique.sourceHash).toBe(referenceHash('C1'));
    expect(unique.byReference).toBe(true);
    expect([dupA, dupB, none].every((p) => !p.byReference && p.sourceHash !== referenceHash(p.entryReference ?? ''))).toBe(true);
  });

  it('a row keeps its code identity when another row of the window changes, and its rate never changes who it is', () => {
    const one = parsePaymentFile(list(tx({ day: '2026-10-02', cents: -1000, currency: 'USD', party: 'A', code: 'C1' })), rates({ [rateKey('USD', '2026-10-02')]: 0.9 }));
    const other = parsePaymentFile(list(tx({ day: '2026-10-02', cents: -1000, currency: 'USD', party: 'A', code: 'C1' }), tx({ day: '2026-10-05', cents: -50, party: 'B' })), rates({ [rateKey('USD', '2026-10-02')]: 0.95 }));
    expect(other.payments[0].sourceHash).toBe(one.payments[0].sourceHash);
    // Without a code: the content identity is built from the dollars, not from the euro amount of the day's rate.
    const a = parsePaymentFile(list(tx({ day: '2026-10-02', cents: -1000, currency: 'USD', party: 'A' })), rates({ [rateKey('USD', '2026-10-02')]: 0.9 }));
    const b = parsePaymentFile(list(tx({ day: '2026-10-02', cents: -1000, currency: 'USD', party: 'A' })), rates({ [rateKey('USD', '2026-10-02')]: 0.95 }));
    expect(a.payments[0].amountCents).not.toBe(b.payments[0].amountCents);
    expect(a.payments[0].sourceHash).toBe(b.payments[0].sourceHash);
  });

  it('names the rates a list needs: one per currency and booked day, none for euro or rows not booked', () => {
    expect(
      walletRateNeeds([
        tx({ day: '2026-10-02', cents: -1000, currency: 'USD' }),
        tx({ day: '2026-10-02', cents: -2000, currency: 'USD' }),
        tx({ day: '2026-10-03', cents: -2000, currency: 'GBP' }),
        tx({ day: '2026-10-03', cents: -2000, currency: 'USD', status: 'RJCT' }),
        tx({ day: '2026-10-03', cents: -2000 }),
      ]),
    ).toEqual([
      { currency: 'USD', day: '2026-10-02' },
      { currency: 'GBP', day: '2026-10-03' },
    ]);
  });
});

describe('the PayPal CSV list names the purchase a conversion belongs to', () => {
  const HEADER =
    'Datum,Uhrzeit,Zeitzone,Name,Typ,Status,Währung,Brutto,Gebühr,Netto,Absender E-Mail-Adresse,Empfänger E-Mail-Adresse,Transaktionscode,Lieferadresse,Adress-Status,Artikelbezeichnung,Artikelnummer,Versand- und Bearbeitungsgebühr,Versicherungsbetrag,Umsatzsteuer,Option 1 Name,Option 1 Wert,Option 2 Name,Option 2 Wert,Zugehöriger Transaktionscode,Rechnungsnummer,Zollnummer,Anzahl,Empfangsnummer,Guthaben,Adresszeile 1,Adresszusatz,Ort,Bundesland,PLZ,Land,Telefon,Betreff,Hinweis,Ländervorwahl,Auswirkung auf Guthaben';
  const row = (o: { name: string; type: string; currency: string; gross: string; code: string; related?: string; effect: string }) => {
    const cells = Array(41).fill('');
    Object.assign(cells, { 0: '04.10.2026', 3: o.name, 4: o.type, 5: 'Abgeschlossen', 6: o.currency, 7: o.gross, 12: o.code, 24: o.related ?? '', 40: o.effect });
    return cells.map((c: string) => `"${c}"`).join(',');
  };

  it('the euro row carries the purchase code as a related one and the dollar amount as its original; its euro amount is real', () => {
    const file = parsePaymentFile(
      [
        HEADER,
        row({ name: 'Hosting Beispiel', type: 'PayPal Express-Zahlung', currency: 'USD', gross: '-10,00', code: 'PUR1', effect: 'Soll' }),
        row({ name: '', type: 'Allgemeine Währungsumrechnung', currency: 'EUR', gross: '-9,41', code: 'CONV1', related: 'PUR1', effect: 'Soll' }),
        row({ name: '', type: 'Allgemeine Währungsumrechnung', currency: 'USD', gross: '10,00', code: 'CONV2', related: 'PUR1', effect: 'Haben' }),
      ].join('\n'),
    );
    expect(file.payments).toHaveLength(1);
    expect(file.payments[0]).toMatchObject({ amountCents: -941, entryReference: 'CONV1', relatedReferences: ['PUR1'], original: { currency: 'USD', amountCents: -1000 } });
    expect(file.payments[0].estimated).toBeUndefined();
  });
});

describe('which sources may share an account', () => {
  it('PayPal list with the interface reading PayPal, bank sources together; nothing else', () => {
    const paypalLive = { format: 'enable_banking_json', service: 'paypal' };
    const bankLive = { format: 'enable_banking_json', service: null };
    expect(sourcesMayShare({ format: 'paypal_csv', service: null }, paypalLive)).toBe(true);
    expect(sourcesMayShare(paypalLive, paypalLive)).toBe(true);
    expect(sourcesMayShare({ format: 'n26_csv', service: null }, bankLive)).toBe(true);
    expect(sourcesMayShare({ format: 'paypal_csv', service: null }, bankLive)).toBe(false);
    expect(sourcesMayShare({ format: 'n26_csv', service: null }, paypalLive)).toBe(false);
    expect(sourcesMayShare(bankLive, paypalLive)).toBe(false);
    expect(sourcesMayShare({ format: 'klarna_csv', service: null }, paypalLive)).toBe(false);
    expect(sourcesMayShare({ format: 'klarna_csv', service: null }, { format: 'paypal_csv', service: null })).toBe(false);
  });
});

describe('the funding rule with a live-fed PayPal wallet', () => {
  const accounts = [
    { id: 'bank', kind: 'bank', formats: ['n26_csv'], services: [null] },
    { id: 'card', kind: 'card', formats: [] },
    // Fed from the list first, then live: both imports name the wallet.
    { id: 'wallet', kind: 'payment_service', formats: ['paypal_csv', 'enable_banking_json'], services: [null, 'paypal'] },
  ];
  let n = 0;
  const payment = (o: Partial<FundingPayment> & { accountId: string }): FundingPayment => ({ id: `p${++n}`, bookingDay: '2026-10-12', amountCents: -1999, counterpartyKey: '', referenceKey: '', sourceKind: 'spend', ...o });
  const span = () => [
    payment({ id: 'w-first', accountId: 'wallet', bookingDay: '2026-10-01', amountCents: -100, counterpartyKey: 'kiosk beispiel' }),
    payment({ id: 'w-last', accountId: 'wallet', bookingDay: '2026-10-31', amountCents: -200, counterpartyKey: 'kiosk beispiel' }),
  ];

  it('recognizes the wallet from the institution stored on its live imports, also with no list import left', () => {
    expect(heldService({ id: 'w', kind: 'payment_service', formats: ['enable_banking_json'], services: ['paypal'] })).toEqual({ name: 'paypal', kind: 'wallet' });
    expect(heldService({ id: 'b', kind: 'bank', formats: ['enable_banking_json'], services: [null] })).toBeNull();
    expect(serviceOfInstitution('PayPal')).toBe('paypal');
    expect(serviceOfInstitution('PayPal (Europe) S.à r.l.')).toBe('paypal');
    expect(serviceOfInstitution('N26')).toBeNull();
  });

  it('a PayPal debit on the bank twins with the live purchase and counts once', () => {
    const purchase = payment({ id: 'live-shop', accountId: 'wallet', bookingDay: '2026-10-11', counterpartyKey: 'laden beispiel' });
    const debit = payment({ accountId: 'bank', counterpartyKey: 'paypal europe s a r l et cie s c a' });
    expect(resolveFunding(accounts, [...span(), purchase, debit]).get(debit.id)).toEqual({ service: 'paypal', serviceKind: 'wallet', kind: 'own_transfer', twinId: 'live-shop' });
  });

  it(`an estimated purchase twins with a card row within ${ESTIMATE_TOLERANCE_PERCENT} percent, not beyond`, () => {
    // 10 dollars at the reference rate: 9.12 euro; PayPal charged 9.48 (4 percent margin).
    const estimate = payment({ id: 'usd', accountId: 'wallet', bookingDay: '2026-10-11', amountCents: -912, counterpartyKey: 'hosting beispiel', estimated: true });
    const near = payment({ accountId: 'card', amountCents: -948, counterpartyKey: 'paypal hosting' });
    expect(resolveFunding(accounts, [...span(), estimate, near]).get(near.id)?.twinId).toBe('usd');
    const far = payment({ accountId: 'card', amountCents: -1000, counterpartyKey: 'paypal hosting' });
    expect(resolveFunding(accounts, [...span(), { ...estimate }, far]).get(far.id)).toBeUndefined();
    // An exact purchase stays exact: one cent off is no twin.
    const exact = payment({ id: 'eur', accountId: 'wallet', bookingDay: '2026-10-11', amountCents: -912, counterpartyKey: 'hosting beispiel' });
    const off = payment({ accountId: 'card', amountCents: -913, counterpartyKey: 'paypal hosting' });
    expect(resolveFunding(accounts, [...span(), exact, off]).get(off.id)).toBeUndefined();
  });

  it('a top-up without a name is a transfer when the same amount leaves another account towards PayPal; else it is asked about', () => {
    const topUp = payment({ id: 'top', accountId: 'wallet', bookingDay: '2026-10-10', amountCents: 5000, sourceKind: 'income' });
    const fromCard = payment({ id: 'card-debit', accountId: 'card', bookingDay: '2026-10-11', amountCents: -5000, counterpartyKey: 'paypal' });
    const result = resolveFunding(accounts, [...span(), topUp, fromCard]);
    expect(result.get('top')).toEqual({ service: 'paypal', serviceKind: 'wallet', kind: 'own_transfer', twinId: null });
    expect(result.get('card-debit')).toEqual({ service: 'paypal', serviceKind: 'wallet', kind: 'own_transfer', twinId: null });
    const alone = payment({ id: 'alone', accountId: 'wallet', bookingDay: '2026-10-10', amountCents: 5000, sourceKind: 'income' });
    expect(resolveFunding(accounts, [...span(), alone]).get('alone')).toBeUndefined();
    // Another amount is no top-up of it.
    const other = payment({ accountId: 'card', bookingDay: '2026-10-11', amountCents: -4999, counterpartyKey: 'paypal' });
    expect(resolveFunding(accounts, [...span(), { ...alone }, other]).get('alone')).toBeUndefined();
  });

  it('of two estimates within the tolerance the closer amount is the twin; two equally close give none', () => {
    const a = payment({ id: 'a', accountId: 'wallet', bookingDay: '2026-10-10', amountCents: -2000, counterpartyKey: 'laden beispiel', estimated: true });
    const b = payment({ id: 'b', accountId: 'wallet', bookingDay: '2026-10-10', amountCents: -2050, counterpartyKey: 'markt beispiel', estimated: true });
    const debit = payment({ id: 'debit', accountId: 'bank', bookingDay: '2026-10-11', amountCents: -2055, counterpartyKey: 'paypal europe' });
    expect(resolveFunding(accounts, [...span(), a, b, debit]).get('debit')?.twinId).toBe('b');
    const c = payment({ id: 'c', accountId: 'wallet', bookingDay: '2026-10-10', amountCents: -2060, counterpartyKey: 'kiosk beispiel', estimated: true });
    // 20.50 and 20.60 are both 5 cents from 20.55: the debit is still the bank's transfer to PayPal, without a twin.
    expect(resolveFunding(accounts, [...span(), b, c, debit]).get('debit')).toEqual({ service: 'paypal', serviceKind: 'wallet', kind: 'own_transfer', twinId: null });
  });

  it('a top-up never takes the bank debit from the purchase it funds, and two equally close debits leave it asked about', () => {
    // PayPal draws a purchase from the bank and shows the money arriving first: the debit stays the purchase's twin.
    const purchase = payment({ id: 'buy', accountId: 'wallet', bookingDay: '2026-10-10', amountCents: -2000, counterpartyKey: 'laden beispiel' });
    const arrival = payment({ id: 'top', accountId: 'wallet', bookingDay: '2026-10-10', amountCents: 2000, sourceKind: 'income' });
    const debit = payment({ id: 'debit', accountId: 'bank', bookingDay: '2026-10-11', amountCents: -2000, counterpartyKey: 'paypal europe' });
    const result = resolveFunding(accounts, [...span(), purchase, arrival, debit]);
    expect(result.get('debit')).toEqual({ service: 'paypal', serviceKind: 'wallet', kind: 'own_transfer', twinId: 'buy' });
    expect(result.get('top')?.kind).toBe('own_transfer');
    // Two debits the same distance away: which one funded the top-up is not known.
    const alone = payment({ id: 'alone', accountId: 'wallet', bookingDay: '2026-10-10', amountCents: 5000, sourceKind: 'income' });
    const before = payment({ id: 'd1', accountId: 'card', bookingDay: '2026-10-09', amountCents: -5000, counterpartyKey: 'paypal' });
    const after = payment({ id: 'd2', accountId: 'card', bookingDay: '2026-10-11', amountCents: -5000, counterpartyKey: 'paypal' });
    const tie = resolveFunding(accounts, [...span(), alone, before, after]);
    expect(tie.get('alone')).toBeUndefined();
    expect(tie.get('d1')).toBeUndefined();
    expect(tie.get('d2')).toBeUndefined();
  });

  it('a payout without a name pairs with the bank credit from PayPal, as with the list', () => {
    const payout = payment({ id: 'out', accountId: 'wallet', bookingDay: '2026-10-14', amountCents: -2500 });
    const credit = payment({ id: 'in', accountId: 'bank', bookingDay: '2026-10-15', amountCents: 2500, counterpartyKey: 'paypal europe', sourceKind: 'income' });
    const result = resolveFunding(accounts, [...span(), payout, credit]);
    expect(result.get('out')?.kind).toBe('own_transfer');
    expect(result.get('in')?.kind).toBe('own_transfer');
  });
});

describe('edge days where one source holds an estimate', () => {
  const stored = (id: string, cents: number, party: string, estimated: boolean) => ({ id, bookingDay: '2026-09-29', amountCents: cents, counterpartyKey: party, estimated });
  const row = (cents: number, party: string, estimated = false) => ({ bookingDay: '2026-09-29', amountCents: cents, counterpartyKey: party, estimated });

  it('exact amounts pair by day and amount, as before', () => {
    expect(matchStored([row(-500, 'a'), row(-500, 'a'), row(-700, 'b')], [stored('s1', -500, 'a', false)])).toMatchObject({ same: [row(-500, 'a')], beyond: [row(-500, 'a'), row(-700, 'b')], settles: [] });
  });

  it('an estimated row pairs with the stored real one by counterparty; a real row settles a stored estimate', () => {
    const live = matchStored([row(-912, 'hosting beispiel', true)], [stored('csv', -948, 'hosting beispiel', false)]);
    expect(live.same).toHaveLength(1);
    expect(live.settles).toEqual([]);
    const csv = matchStored([row(-948, 'hosting beispiel')], [stored('live', -912, 'hosting beispiel', true)]);
    expect(csv.same).toHaveLength(1);
    expect(csv.settles).toEqual([{ row: row(-948, 'hosting beispiel'), storedId: 'live' }]);
  });

  it('an estimate pairs by counterparty only within the conversion tolerance: another purchase of the merchant that day is not it', () => {
    // A 100 dollar estimate and a 5 euro purchase of the same merchant: two movements, and the estimate keeps its amount.
    const csv = matchStored([row(-500, 'hosting beispiel')], [stored('live', -9000, 'hosting beispiel', true)]);
    expect(csv).toMatchObject({ same: [], settles: [], beyond: [row(-500, 'hosting beispiel')] });
    const live = matchStored([row(-9000, 'hosting beispiel', true)], [stored('csv', -500, 'hosting beispiel', false)]);
    expect(live).toMatchObject({ same: [], beyond: [row(-9000, 'hosting beispiel', true)] });
    // Just inside the tolerance it is the same purchase, just outside it is not.
    expect(matchStored([row(-1060, 'a')], [stored('e', -1000, 'a', true)]).settles).toHaveLength(1);
    expect(matchStored([row(-1061, 'a')], [stored('e', -1000, 'a', true)]).settles).toHaveLength(0);
  });

  it('never pairs by counterparty without a name, across money in and out, or a stored movement twice', () => {
    expect(matchStored([row(-912, '', true)], [stored('x', -948, '', false)]).beyond).toHaveLength(1);
    expect(matchStored([row(912, 'a', true)], [stored('x', -948, 'a', false)]).beyond).toHaveLength(1);
    const twice = matchStored([row(-500, 'a'), row(-912, 'a', true)], [stored('x', -500, 'a', false)]);
    expect(twice.same).toHaveLength(1);
    expect(twice.beyond).toHaveLength(1);
  });
});

describe('links of an estimate scaled to its real amount', () => {
  const links = (...cents: number[]) => cents.map((c, i) => ({ id: `l${i}`, cents: c }));
  const sum = (xs: Array<{ cents: number }>) => xs.reduce((s, x) => s + x.cents, 0);

  it('links that covered the whole payment cover the whole real amount, shares kept', () => {
    expect(scaleLinks(links(450), 450, 471)).toEqual([{ id: 'l0', cents: 471 }]);
    expect(scaleLinks(links(500, 400), 900, 943)).toEqual([{ id: 'l0', cents: 524 }, { id: 'l1', cents: 419 }]);
    // Three equal thirds of 100 to 101: the cent left goes to the first.
    expect(scaleLinks(links(33, 33, 34), 100, 101).map((l) => l.cents)).toEqual([33, 33, 35]);
  });

  it('a part of the payment stays a part, and many small links never go below nothing', () => {
    const part = scaleLinks(links(200), 450, 471);
    expect(part).toEqual([{ id: 'l0', cents: 209 }]);
    const many = scaleLinks(links(1, 1, 1, 1, 1, 1, 1, 1, 1, 1), 10, 7);
    expect(sum(many)).toBe(7);
    expect(many.every((l) => l.cents >= 0)).toBe(true);
    expect(many.filter((l) => l.cents === 0)).toHaveLength(3);
  });

  it('links that said more than the payment come down to the real amount', () => {
    const over = scaleLinks(links(300, 300), 500, 480);
    expect(sum(over)).toBe(480);
    expect(over.every((l) => l.cents >= 0)).toBe(true);
  });
});
