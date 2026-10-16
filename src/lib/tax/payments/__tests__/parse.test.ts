import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { homeDay, parseCsv, parsePaymentFile, referenceHash, toCents, toIsoDay } from '../parse';
import { PaymentParseError } from '../types';

/** Every name, text and amount below is invented; only the column layouts are the real ones. */

const N26 = `"Booking Date","Value Date","Partner Name","Partner Iban",Type,"Payment Reference","Account Name","Amount (EUR)","Original Amount","Original Currency","Exchange Rate"
2026-01-05,2026-01-05,"Werkzeug Beispiel GmbH",DE00000000000000000000,Presentment,"Bestellung 4711, Rest",Hauptkonto,-49.9,,,
2026-01-06,2026-01-06,"Kundin Beispiel",DE00000000000000000001,Credit Transfer,"Rechnung R-2026-001",Hauptkonto,1000,,,
2026-01-31,2026-01-31,,,Fee,"Kontoführung",Hauptkonto,-4.9,,,
`;

const TOMORROW = `account_type,booking_date,valuta_date,sender_or_recipient,iban,booking_type,description,category,amount,currency
Personal Account,2026-02-01,2026-02-01,Laden Beispiel,,Card Payment,Einkauf,shopping,"-1.234,56",EUR
Personal Account,2026-02-03,2026-02-03,Versorger Beispiel,DE00,Direct Debit return,Rücklastschrift,utilities,"45,00",EUR
Personal Account,2026-02-04,2026-02-04,Kunde Beispiel,DE00,Payment,Honorar R-2026-002,income,"350,00",EUR
`;

const PAYPAL_HEADER =
  'Datum,Uhrzeit,Zeitzone,Name,Typ,Status,Währung,Brutto,Gebühr,Netto,Absender E-Mail-Adresse,Empfänger E-Mail-Adresse,Transaktionscode,Lieferadresse,Adress-Status,Artikelbezeichnung,Artikelnummer,Versand- und Bearbeitungsgebühr,Versicherungsbetrag,Umsatzsteuer,Option 1 Name,Option 1 Wert,Option 2 Name,Option 2 Wert,Zugehöriger Transaktionscode,Rechnungsnummer,Zollnummer,Anzahl,Empfangsnummer,Guthaben,Adresszeile 1,Adresszusatz,Ort,Bundesland,PLZ,Land,Telefon,Betreff,Hinweis,Ländervorwahl,Auswirkung auf Guthaben';
const paypalRow = (o: { date: string; name: string; type: string; status: string; currency: string; gross: string; code: string; item?: string; effect: string; related?: string }) => {
  const cells = Array(41).fill('');
  Object.assign(cells, { 0: o.date, 3: o.name, 4: o.type, 5: o.status, 6: o.currency, 7: o.gross, 12: o.code, 15: o.item ?? '', 24: o.related ?? '', 40: o.effect });
  return cells.map((c: string) => `"${c}"`).join(',');
};
const PAYPAL = [
  PAYPAL_HEADER,
  paypalRow({ date: '03.03.2026', name: 'Software Beispiel', type: 'PayPal Express-Zahlung', status: 'Abgeschlossen', currency: 'EUR', gross: '-19,99', code: 'TX1', item: 'Lizenz', effect: 'Soll' }),
  paypalRow({ date: '03.03.2026', name: '', type: 'Bankgutschrift auf PayPal-Konto ', status: 'Abgeschlossen', currency: 'EUR', gross: '19,99', code: 'TX2', effect: 'Haben' }),
  paypalRow({ date: '04.03.2026', name: 'Cloud Beispiel', type: 'Zahlung im Einzugsverfahren mit Zahlungsrechnung', status: 'Abgeschlossen', currency: 'USD', gross: '-20,00', code: 'TX3', effect: 'Soll' }),
  paypalRow({ date: '05.03.2026', name: 'Laden Beispiel', type: 'Allgemeine Autorisierung', status: 'Ausstehend', currency: 'EUR', gross: '-5,00', code: 'TX4', effect: 'Memo' }),
  paypalRow({ date: '06.03.2026', name: 'Laden Beispiel', type: 'Rückzahlung', status: 'Abgeschlossen', currency: 'EUR', gross: '7,50', code: 'TX5', effect: 'Haben' }),
].join('\n');

const bankEntry = (o: Record<string, unknown>) => ({
  status: 'BOOK',
  booking_date: '2026-04-02',
  value_date: '2026-04-02',
  transaction_amount: { amount: '12.5', currency: 'EUR' },
  credit_debit_indicator: 'DBIT',
  creditor: { name: 'Laden Beispiel' },
  debtor: { name: null },
  remittance_information: ['Einkauf', 'Filiale 3'],
  entry_reference: null,
  ...o,
});

describe('helpers', () => {
  it('reads both date notations and rejects days that do not exist', () => {
    expect(toIsoDay('2026-01-05')).toBe('2026-01-05');
    expect(toIsoDay('05.01.2026')).toBe('2026-01-05');
    expect(toIsoDay('2026-02-30')).toBeNull();
    expect(toIsoDay('5.1.26')).toBeNull();
    expect(toIsoDay(null)).toBeNull();
  });

  it('reads signed amounts in both notations', () => {
    expect(toCents('-49.9')).toBe(-4990);
    expect(toCents('1000')).toBe(100_000);
    expect(toCents('-1.234,56')).toBe(-123_456);
    expect(toCents('9.9')).toBe(990);
    expect(toCents('')).toBeNull();
    expect(toCents('zwölf')).toBeNull();
  });

  it('splits CSV with quotes, doubled quotes, commas and line breaks inside a field', () => {
    expect(parseCsv('a,b\n"x, y","say ""hi"""\n"two\nlines",z\n')).toEqual([['a', 'b'], ['x, y', 'say "hi"'], ['two\nlines', 'z']]);
    expect(parseCsv('﻿a,b\r\n1,2\r\n')).toEqual([['a', 'b'], ['1', '2']]);
  });
});

describe('parsePaymentFile: layouts', () => {
  it('reads an N26 export', () => {
    const file = parsePaymentFile(N26);
    expect(file).toMatchObject({ format: 'n26_csv', firstDay: '2026-01-05', lastDay: '2026-01-31', skipped: {} });
    expect(file.payments.map((p) => [p.bookingDay, p.amountCents, p.counterparty, p.reference, p.kind])).toEqual([
      ['2026-01-05', -4990, 'Werkzeug Beispiel GmbH', 'Bestellung 4711, Rest', 'spend'],
      ['2026-01-06', 100_000, 'Kundin Beispiel', 'Rechnung R-2026-001', 'income'],
      ['2026-01-31', -490, '', 'Kontoführung', 'fee'],
    ]);
  });

  it('reads a Tomorrow export; a returned direct debit is a refund, not income', () => {
    const file = parsePaymentFile(TOMORROW);
    expect(file.format).toBe('tomorrow_csv');
    expect(file.payments.map((p) => [p.amountCents, p.kind])).toEqual([[-123_456, 'spend'], [4_500, 'refund'], [35_000, 'income']]);
  });

  it('reads a PayPal export: only completed euro movements, funding is no spend', () => {
    const file = parsePaymentFile(PAYPAL);
    expect(file.format).toBe('paypal_csv');
    expect(file.payments.map((p) => [p.bookingDay, p.amountCents, p.kind, p.entryReference])).toEqual([
      ['2026-03-03', -1999, 'spend', 'TX1'],
      ['2026-03-03', 1999, 'own_transfer', 'TX2'],
      ['2026-03-06', 750, 'refund', 'TX5'],
    ]);
    expect(file.skipped).toEqual({ other_currency: 1, not_completed: 1 });
  });

  it('reads the bank interface list: booked only, sign from the indicator, the other side by direction', () => {
    const file = parsePaymentFile(
      JSON.stringify([
        bankEntry({}),
        bankEntry({ credit_debit_indicator: 'CRDT', creditor: { name: null }, debtor: { name: 'Kunde Beispiel' }, transaction_amount: { amount: '350.00', currency: 'EUR' }, entry_reference: 'E-1' }),
        bankEntry({ status: 'PDNG' }),
        bankEntry({ transaction_amount: { amount: '20.00', currency: 'USD' } }),
        bankEntry({ booking_date: null, transaction_date: '2026-04-09' }),
      ]),
    );
    expect(file.format).toBe('enable_banking_json');
    expect(file.payments.map((p) => [p.bookingDay, p.amountCents, p.counterparty, p.reference, p.entryReference])).toEqual([
      ['2026-04-02', -1250, 'Laden Beispiel', 'Einkauf Filiale 3', null],
      ['2026-04-02', 35_000, 'Kunde Beispiel', 'Einkauf Filiale 3', 'E-1'],
      ['2026-04-09', -1250, 'Laden Beispiel', 'Einkauf Filiale 3', null],
    ]);
    expect(file.skipped).toEqual({ not_booked: 1, other_currency: 1 });
    expect(parsePaymentFile(JSON.stringify({ transactions: [bankEntry({})] })).payments).toHaveLength(1);
  });
});

describe('parsePaymentFile: a PayPal purchase in another currency', () => {
  const rows = (...extra: string[]) =>
    [
      PAYPAL_HEADER,
      paypalRow({ date: '04.03.2026', name: 'Cloud Beispiel', type: 'Zahlung im Einzugsverfahren mit Zahlungsrechnung', status: 'Abgeschlossen', currency: 'USD', gross: '-20,00', code: 'TX3', item: 'Speicher März', effect: 'Soll' }),
      paypalRow({ date: '04.03.2026', name: '', type: 'Allgemeine Währungsumrechnung', status: 'Abgeschlossen', currency: 'EUR', gross: '-18,73', code: 'TX3A', related: 'TX3', effect: 'Soll' }),
      paypalRow({ date: '04.03.2026', name: '', type: 'Allgemeine Währungsumrechnung', status: 'Abgeschlossen', currency: 'USD', gross: '20,00', code: 'TX3B', related: 'TX3', effect: 'Haben' }),
      ...extra,
    ].join('\n');

  it('the euro conversion is the spend, under the name and text of the purchase', () => {
    const file = parsePaymentFile(rows());
    expect(file.payments.map((p) => [p.counterparty, p.amountCents, p.kind, p.reference])).toEqual([['Cloud Beispiel', -1873, 'spend', 'Speicher März']]);
    expect(file.skipped).toEqual({ other_currency: 2 });
  });

  it('money back on such a purchase is a refund; a conversion that belongs to no purchase only moves money', () => {
    const file = parsePaymentFile(
      rows(
        paypalRow({ date: '09.03.2026', name: 'Cloud Beispiel', type: 'Rückzahlung', status: 'Abgeschlossen', currency: 'USD', gross: '20,00', code: 'TX6', effect: 'Haben' }),
        paypalRow({ date: '09.03.2026', name: '', type: 'Allgemeine Währungsumrechnung', status: 'Abgeschlossen', currency: 'EUR', gross: '18,10', code: 'TX6A', related: 'TX6', effect: 'Haben' }),
        paypalRow({ date: '10.03.2026', name: '', type: 'Allgemeine Währungsumrechnung', status: 'Abgeschlossen', currency: 'EUR', gross: '-5,00', code: 'TX7A', related: 'GONE', effect: 'Soll' }),
      ),
    );
    expect(file.payments.map((p) => [p.counterparty, p.amountCents, p.kind])).toEqual([
      ['Cloud Beispiel', -1873, 'spend'],
      ['Cloud Beispiel', 1810, 'refund'],
      ['', -500, 'own_transfer'],
    ]);
  });
});

describe('parsePaymentFile: PayPal income in another currency', () => {
  it('the euro side of a payment received in dollars is income from the payer, not a refund', () => {
    const file = parsePaymentFile(
      [
        PAYPAL_HEADER,
        paypalRow({ date: '11.03.2026', name: 'Kunde Übersee', type: 'Website-Zahlung', status: 'Abgeschlossen', currency: 'USD', gross: '1.000,00', code: 'TX8', item: 'Rechnung R-2026-009', effect: 'Haben' }),
        paypalRow({ date: '11.03.2026', name: '', type: 'Allgemeine Währungsumrechnung', status: 'Abgeschlossen', currency: 'USD', gross: '-1.000,00', code: 'TX8B', related: 'TX8', effect: 'Soll' }),
        paypalRow({ date: '11.03.2026', name: '', type: 'Allgemeine Währungsumrechnung', status: 'Abgeschlossen', currency: 'EUR', gross: '921,40', code: 'TX8A', related: 'TX8', effect: 'Haben' }),
      ].join('\n'),
    );
    expect(file.payments.map((p) => [p.counterparty, p.amountCents, p.kind, p.reference])).toEqual([['Kunde Übersee', 92_140, 'income', 'Rechnung R-2026-009']]);
  });
});

describe('toCents: nothing is guessed', () => {
  it.each(['1,234.56', '1.234', '12.345', '1,234', '1.23.456,00', '12,3,4', '1e3', '20000000', '20.000.000,00'])('rejects %s', (text) => {
    expect(toCents(text)).toBeNull();
  });

  it.each([
    ['1.234,56', 123_456],
    ['-1.234.567,8', -123_456_780],
    ['1234,5', 123_450],
    ['-49.9', -4_990],
    ['1000', 100_000],
    ['0.07', 7],
    ['9999999,99', 999_999_999],
  ])('reads %s', (text, cents) => {
    expect(toCents(text)).toBe(cents);
  });
});

describe('parsePaymentFile: identity across files', () => {
  it('gives the same movement the same hash in an overlapping export', () => {
    const first = parsePaymentFile(N26);
    const overlap = parsePaymentFile(N26.split('\n').filter((_, i) => i !== 1).join('\n'));
    const hashes = new Set(first.payments.map((p) => p.sourceHash));
    expect(overlap.payments.every((p) => hashes.has(p.sourceHash))).toBe(true);
  });

  it('tells two genuinely identical movements apart by their order, stably', () => {
    const twice = JSON.stringify([bankEntry({}), bankEntry({})]);
    const a = parsePaymentFile(twice).payments;
    const b = parsePaymentFile(twice).payments;
    expect(a[0].sourceHash).not.toBe(a[1].sourceHash);
    expect(a.map((p) => p.sourceHash)).toEqual(b.map((p) => p.sourceHash));
  });

  it('does not trust the bank\'s reference to be unique: same reference, different day, different payment', () => {
    const file = parsePaymentFile(JSON.stringify([bankEntry({ entry_reference: 'R' }), bankEntry({ entry_reference: 'R', booking_date: '2026-04-03' })]));
    expect(new Set(file.payments.map((p) => p.sourceHash)).size).toBe(2);
  });
});

describe('parsePaymentFile: unhappy paths', () => {
  const code = (text: string) => {
    try {
      parsePaymentFile(text);
    } catch (e) {
      return e instanceof PaymentParseError ? [e.code, e.row] : ['unexpected', String(e)];
    }
    return ['no error', null];
  };

  it('rejects an unknown layout, an empty file and broken JSON', () => {
    expect(code('date,what,amount\n2026-01-01,x,1\n')).toEqual(['unknown_layout', null]);
    expect(code('   ')).toEqual(['empty', null]);
    expect(code('[{"status":')).toEqual(['unknown_layout', null]);
    expect(code('{"something":"else"}')).toEqual(['unknown_layout', null]);
    expect(code(N26.split('\n')[0] + '\n')).toEqual(['empty', null]);
  });

  it('rejects the whole file at the first unreadable row and names it', () => {
    expect(code(N26.replace('-49.9', 'viel'))).toEqual(['unreadable_row', 2]);
    expect(code(N26.replace('2026-01-06,2026-01-06', '2026-13-45,2026-01-06'))).toEqual(['unreadable_row', 3]);
    expect(code(N26 + '2026-02-01,only,three\n')).toEqual(['unreadable_row', 5]);
    expect(code(JSON.stringify([bankEntry({}), bankEntry({ credit_debit_indicator: 'XXXX' })]))).toEqual(['unreadable_row', 2]);
  });

  it('refuses a file that is too large to be an export', () => {
    expect(code('x'.repeat(8 * 1024 * 1024 + 1))).toEqual(['too_large', null]);
  });
});

// The purchase list of the pay-later service, in its longer variant. The shorter one ends after `statement_number`.
const KLARNA_HEADER = 'created_date,created_time,activated,settled,amount,currency,merchant,items,payment_method,status,payment_reference,statement_number,category,purchase_type,card,source,timezone';
const klarnaRow = (o: { day: string; amount: string; merchant: string; items?: string; status?: string; reference?: string; order?: string; activated?: string; currency?: string; method?: string; time?: string; zone?: string; card?: string }) =>
  [o.day, o.time ?? '09:30', o.activated ?? `${o.day} 09:31`, '', o.amount, o.currency ?? 'EUR', `"${o.merchant}"`, `"${o.items ?? ''}"`, o.method ?? 'Invoice', `"${o.status ?? 'Normal'}"`, o.reference ?? '', o.order ?? 'ORDER0001', '', '', o.card ?? '', 'beispiel-quelle', o.zone ?? 'Europe/Berlin'].join(',');
const klarna = (...rows: string[]) => [KLARNA_HEADER, ...rows].join('\r\n') + '\r\n';
const KLARNA = klarna(
  klarnaRow({ day: '2025-03-02', activated: '2025-03-03 08:00', amount: '21.37', merchant: 'Editor Beispiel', items: 'Editor Beispiel Pro Monat', reference: '1000000000001' }),
  klarnaRow({ day: '2025-03-05', amount: '240.00', merchant: 'Möbel Beispiel', items: 'Schreibtisch', method: 'Term Loan', reference: '1000000000002' }),
  klarnaRow({ day: '2025-03-09', activated: '', amount: '9.99', merchant: 'ZAHLDIENST *Laden Beispiel', reference: '', order: 'ORDER0003' }),
);

describe('the pay-later purchase list', () => {
  const code = (text: string) => {
    try {
      parsePaymentFile(text);
    } catch (e) {
      return e instanceof PaymentParseError ? [e.code, e.row] : ['unexpected', String(e)];
    }
    return ['no error', null];
  };

  it('reads a purchase as money out on the day it was made, with the capture day as value day', () => {
    const parsed = parsePaymentFile(KLARNA);
    expect(parsed).toMatchObject({ format: 'klarna_csv', skipped: {}, firstDay: '2025-03-02', lastDay: '2025-03-09' });
    expect(parsed.payments.map((p) => ({ ...p, sourceHash: undefined, byReference: undefined, detail: undefined }))).toEqual([
      { bookingDay: '2025-03-02', valueDay: '2025-03-03', amountCents: -2137, counterparty: 'Editor Beispiel', reference: 'Editor Beispiel Pro Monat', entryReference: '1000000000001', kind: 'spend', sourceHash: undefined },
      // Bought on instalments: one spend of the full amount on the purchase day.
      { bookingDay: '2025-03-05', valueDay: '2025-03-05', amountCents: -24_000, counterparty: 'Möbel Beispiel', reference: 'Schreibtisch', entryReference: '1000000000002', kind: 'spend', sourceHash: undefined },
      // A row read from the web pages: no capture day, no payment reference, the order number stands in.
      { bookingDay: '2025-03-09', valueDay: null, amountCents: -999, counterparty: 'ZAHLDIENST *Laden Beispiel', reference: '', entryReference: 'ORDER0003', kind: 'spend', sourceHash: undefined },
    ]);
  });

  it('keeps how each purchase was paid: the method wording, a marked card, the statement and its own number', () => {
    const parsed = parsePaymentFile(
      klarna(
        klarnaRow({ day: '2025-03-02', amount: '21.37', merchant: 'Editor Beispiel', reference: '1000000000001', order: '7ABCDEFG' }),
        klarnaRow({ day: '2025-03-03', amount: '12.00', merchant: 'Café Beispiel', method: 'In 30 Tagen zahlen', card: '•••• 1234', reference: '1000000000002' }),
        klarnaRow({ day: '2025-03-04', amount: '5.00', merchant: 'Laden Beispiel', method: '', reference: '1000000000003', order: '' }),
      ),
    );
    expect(parsed.payments.map((p) => p.detail)).toEqual([
      { method: 'Invoice', card: false, statement: '7ABCDEFG', reference: '1000000000001' },
      { method: 'In 30 Tagen zahlen', card: true, statement: 'ORDER0001', reference: '1000000000002' },
      { method: '', card: false, statement: null, reference: '1000000000003' },
    ]);
  });

  it('names a payment method wording it does not know, and still reads the purchase', () => {
    const parsed = parsePaymentFile(
      klarna(
        klarnaRow({ day: '2025-03-02', amount: '10.00', merchant: 'Laden Beispiel', method: 'Flexible Amount', reference: '1100000000001' }),
        klarnaRow({ day: '2025-03-03', amount: '20.00', merchant: 'Laden Beispiel', method: 'Flexible Amount', reference: '1100000000002' }),
        klarnaRow({ day: '2025-03-04', amount: '30.00', merchant: 'Laden Beispiel', method: '', reference: '1100000000003' }),
        klarnaRow({ day: '2025-03-05', amount: '40.00', merchant: 'Laden Beispiel', method: 'In 14 Tagen zahlen', reference: '1100000000004' }),
        klarnaRow({ day: '2025-03-06', amount: '50.00', merchant: 'Laden Beispiel', method: 'Cards', reference: '1100000000005' }),
        klarnaRow({ day: '2025-03-07', amount: '60.00', merchant: 'Laden Beispiel', method: 'Direct Debit', reference: '1100000000006' }),
      ),
    );
    expect(parsed.payments).toHaveLength(6);
    expect(parsed.notices).toEqual({ unknown_method: 3 });
    expect(parsed.unknownMethods).toEqual(['Flexible Amount', '(leer)']);
    // Known wordings (Invoice, Term Loan) are not named.
    expect(parsePaymentFile(KLARNA).unknownMethods).toEqual([]);
  });

  it('is recognized by its column names: the shorter variant and reordered columns read the same', () => {
    const rows = parseCsv(KLARNA);
    const short = rows.map((r) => r.slice(0, 12).map((c) => `"${c}"`).join(',')).join('\n');
    const reversed = rows.map((r) => [...r].reverse().map((c) => `"${c}"`).join(',')).join('\n');
    const hashes = (text: string) => parsePaymentFile(text).payments.map((p) => p.sourceHash);
    expect(parsePaymentFile(short).format).toBe('klarna_csv');
    expect(hashes(short)).toEqual(hashes(KLARNA));
    expect(hashes(reversed)).toEqual(hashes(KLARNA));
  });

  it('identifies a purchase by the payment reference alone, so a corrected name or text does not store it twice', () => {
    const other = klarna(klarnaRow({ day: '2025-03-02', amount: '21.37', merchant: 'EDITOR BEISPIEL INC', items: '', reference: '1000000000001' }));
    expect(parsePaymentFile(other).payments[0].sourceHash).toBe(parsePaymentFile(KLARNA).payments[0].sourceHash);
    // Without a reference two identical purchases of one day are told apart by their order, as in every other source.
    const twins = klarna(klarnaRow({ day: '2025-04-01', amount: '5.00', merchant: 'Kiosk Beispiel' }), klarnaRow({ day: '2025-04-01', amount: '5.00', merchant: 'Kiosk Beispiel' }));
    const [a, b] = parsePaymentFile(twins).payments;
    expect(a.sourceHash).not.toBe(b.sourceHash);
  });

  it('leaves out what is no payment, and says how many of each', () => {
    const parsed = parsePaymentFile(
      klarna(
        klarnaRow({ day: '2025-05-01', amount: '10.00', merchant: 'Laden Beispiel', reference: '2000000000001' }),
        klarnaRow({ day: '2025-05-01', amount: '10.00', merchant: 'Laden Beispiel', reference: '2000000000001' }),
        klarnaRow({ day: '2025-05-02', amount: '30.00', merchant: 'Auslandsladen Beispiel', currency: 'USD', reference: '2000000000002' }),
        klarnaRow({ day: '2025-05-03', amount: '40.00', merchant: 'Laden Beispiel', status: 'Wenn der Händler deine Bestellung bearbeitet, ist deine Zahlung 30 Tage später fällig', reference: '2000000000003' }),
        klarnaRow({ day: '2025-05-04', amount: '50.00', merchant: 'Laden Beispiel', status: 'Storniert', reference: '2000000000004' }),
        klarnaRow({ day: '2025-05-05', amount: '60.00', merchant: 'Laden Beispiel', status: 'Vollständig erstattet', reference: '2000000000005' }),
        klarnaRow({ day: '2025-05-06', amount: '0.00', merchant: 'Laden Beispiel', reference: '2000000000006' }),
        klarnaRow({ day: '2025-05-07', amount: '70.00', merchant: 'Laden Beispiel', status: 'Teilweise erstattet', reference: '2000000000007' }),
        klarnaRow({ day: '2025-05-08', amount: '80.00', merchant: 'Laden Beispiel', status: 'In 12 Tagen fällig', reference: '2000000000008' }),
      ),
    );
    expect(parsed.skipped).toEqual({ duplicate_row: 1, other_currency: 1, not_completed: 1, cancelled: 2, zero_amount: 1 });
    // The cancelled and the fully refunded purchase are named by identity, so an earlier import of them stops counting.
    expect(parsed.cancelled).toEqual([referenceHash('2000000000004'), referenceHash('2000000000005')]);
    expect(parsed.notices).toEqual({ part_refunded: 1 });
    // A part refund keeps the purchase in full; a purchase that is merely not due yet is a purchase.
    expect(parsed.payments.map((p) => [p.bookingDay, p.amountCents])).toEqual([['2025-05-01', -1000], ['2025-05-07', -7000], ['2025-05-08', -8000]]);
  });

  it('names every status it knows, and refuses the file at a word it does not know', () => {
    const kept = (status: string) => {
      const parsed = parsePaymentFile(klarna(klarnaRow({ day: '2025-05-01', amount: '10.00', merchant: 'Laden Beispiel', status, reference: '2100000000001' })));
      return parsed.payments.length === 1 ? (parsed.notices.part_refunded ? 'purchase, part refunded' : 'purchase') : Object.keys(parsed.skipped)[0];
    };
    // The statuses of the real list, and an empty one.
    for (const status of ['Normal', 'read', 'Gestern bezahlt', 'Heute bezahlt', 'Am 5. Sept. bezahlt', 'Am 12. Aug. bezahlt', 'In 12 Tagen fällig', 'Überfällig', '']) expect([status, kept(status)]).toEqual([status, 'purchase']);
    expect(kept('Wenn der Händler deine Bestellung bearbeitet, ist deine Zahlung 30 Tage später fällig')).toBe('not_completed');
    for (const status of ['In Bearbeitung', 'Ausstehend', 'Pending']) expect([status, kept(status)]).toEqual([status, 'not_completed']);
    for (const status of ['Storniert', 'Cancelled', 'Erstattet', 'Vollständig erstattet', 'Refunded']) expect([status, kept(status)]).toEqual([status, 'cancelled']);
    // A part refund keeps the purchase, whatever the spelling: "erstattet" inside the word must not drop it.
    for (const status of ['Teilweise erstattet', 'Teilerstattet', 'Teilerstattung', 'Partially refunded']) expect([status, kept(status)]).toEqual([status, 'purchase, part refunded']);
    // The wordings of the real list are relative to the export day: any day, any number of days.
    for (const status of ['Am 31. Aug. bezahlt', 'Am 2. Sept. bezahlt', 'In 13 Tagen fällig', 'In 30 Tagen fällig']) expect([status, kept(status)]).toEqual([status, 'purchase']);
  });

  it('a wording it does not know is read as a purchase and named for a look, never dropped and never a reason to refuse the file', () => {
    // "bearbeitet" alone is not the pending sentence, and "erstattet" inside another sentence is not a full refund.
    const parsed = parsePaymentFile(
      klarna(
        klarnaRow({ day: '2025-05-01', amount: '10.00', merchant: 'Laden Beispiel', status: 'Bearbeitet', reference: '2200000000001' }),
        klarnaRow({ day: '2025-05-02', amount: '20.00', merchant: 'Laden Beispiel', status: 'Angefochten', reference: '2200000000002' }),
        klarnaRow({ day: '2025-05-03', amount: '30.00', merchant: 'Laden Beispiel', status: 'Angefochten', reference: '2200000000003' }),
        klarnaRow({ day: '2025-05-04', amount: '40.00', merchant: 'Laden Beispiel', reference: '2200000000004' }),
      ),
    );
    expect(parsed.payments.map((p) => p.amountCents)).toEqual([-1000, -2000, -3000, -4000]);
    expect(parsed.skipped).toEqual({});
    expect(parsed.notices).toEqual({ unknown_status: 3 });
    expect(parsed.unknownStatuses).toEqual(['Bearbeitet', 'Angefochten']);
  });

  it('reads the currency whatever its case', () => {
    expect(parsePaymentFile(klarna(klarnaRow({ day: '2025-05-01', amount: '10.00', merchant: 'Laden Beispiel', currency: 'eur' }))).payments.length).toBe(1);
    expect(parsePaymentFile(klarna(klarnaRow({ day: '2025-05-01', amount: '10.00', merchant: 'Laden Beispiel', currency: 'usd' }))).skipped).toEqual({ other_currency: 1 });
  });

  it('money back that carries its purchase’s reference is a movement of its own, not a second copy of the purchase', () => {
    const parsed = parsePaymentFile(
      klarna(
        klarnaRow({ day: '2025-06-01', amount: '40.00', merchant: 'Laden Beispiel', reference: '3100000000001' }),
        klarnaRow({ day: '2025-06-09', amount: '-15.00', merchant: 'Laden Beispiel', reference: '3100000000001' }),
        klarnaRow({ day: '2025-06-09', amount: '-15.00', merchant: 'Laden Beispiel', reference: '3100000000001' }),
      ),
    );
    expect(parsed.payments.map((p) => [p.bookingDay, p.amountCents, p.kind])).toEqual([['2025-06-01', -4000, 'spend'], ['2025-06-09', 1500, 'refund']]);
    expect(parsed.skipped).toEqual({ duplicate_row: 1 });
    expect(parsed.payments[0].sourceHash).not.toBe(parsed.payments[1].sourceHash);
  });

  it('a row without a reference that a referenced row repeats is that purchase, when neither side could mean another row', () => {
    const web = klarnaRow({ day: '2025-07-01', amount: '9.00', merchant: 'Laden Beispiel', order: 'WEB1' });
    const extract = klarnaRow({ day: '2025-07-01', amount: '9.00', merchant: 'LADEN BEISPIEL', reference: '3200000000001' });
    const one = parsePaymentFile(klarna(web, extract));
    expect(one.payments.map((p) => p.entryReference)).toEqual(['3200000000001']);
    expect(one.skipped).toEqual({ duplicate_row: 1 });
    // Two referenced purchases of that day, amount and merchant: the unreferenced row may be a third, so all stay.
    const other = klarnaRow({ day: '2025-07-01', amount: '9.00', merchant: 'Laden Beispiel', reference: '3200000000002' });
    expect(parsePaymentFile(klarna(web, extract, other)).payments.length).toBe(3);
    // Another amount or another day is another purchase.
    expect(parsePaymentFile(klarna(web, extract.replace('9.00', '9.50'))).payments.length).toBe(2);
  });

  it('takes the day in German time: a list in another time zone moves a purchase near midnight to its real day', () => {
    expect(homeDay('2025-12-31', '23:30', 'UTC')).toBe('2026-01-01');
    expect(homeDay('2025-07-01', '21:59', 'UTC')).toBe('2025-07-01');
    expect(homeDay('2025-07-01', '22:00', 'UTC')).toBe('2025-07-02');
    expect(homeDay('2025-03-10', '02:00', 'America/New_York')).toBe('2025-03-10');
    expect(homeDay('2025-03-10', '20:00', 'America/New_York')).toBe('2025-03-11');
    // The list's own zone, a missing zone or a missing time leave the day as written.
    expect(homeDay('2025-12-31', '23:30', 'Europe/Berlin')).toBe('2025-12-31');
    expect(homeDay('2025-12-31', '23:30', '')).toBe('2025-12-31');
    expect(homeDay('2025-12-31', '', 'UTC')).toBe('2025-12-31');
    expect(homeDay('2025-12-31', '23:30', 'Nirgendwo/Stadt')).toBeNull();

    const [late] = parsePaymentFile(klarna(klarnaRow({ day: '2025-12-31', time: '23:30', zone: 'UTC', amount: '10.00', merchant: 'Laden Beispiel' }))).payments;
    expect(late.bookingDay).toBe('2026-01-01');
    expect(code(klarna(klarnaRow({ day: '2025-12-31', time: '23:30', zone: 'Nirgendwo/Stadt', amount: '10.00', merchant: 'Laden Beispiel' })))).toEqual(['unreadable_row', 2]);
  });

  it('reads a negative amount as money back', () => {
    const [refund] = parsePaymentFile(klarna(klarnaRow({ day: '2025-06-01', amount: '-12.50', merchant: 'Laden Beispiel', reference: '3000000000001' }))).payments;
    expect(refund).toMatchObject({ amountCents: 1250, kind: 'refund' });
  });

  it('a file with only the header is empty; one unreadable row rejects the whole file', () => {
    expect(code(KLARNA_HEADER + '\n')).toEqual(['empty', null]);
    expect(code(klarna(klarnaRow({ day: '2025-06-01', amount: '12,50 €', merchant: 'Laden Beispiel' })))).toEqual(['unreadable_row', 2]);
    expect(code(KLARNA.replace('2025-03-05,09:30', '05.03.25,09:30'))).toEqual(['unreadable_row', 3]);
  });

  it('a list of the same columns without the amount is not taken for a purchase list', () => {
    expect(code('created_date,merchant,status\n2025-01-01,Laden Beispiel,Normal\n')).toEqual(['unknown_layout', null]);
  });
});

/**
 * Local only: the owner's real exports must parse without an unreadable row.
 * Point TAX_PAYMENT_FILES_DIR at a folder of exports. Nothing but counts is
 * printed or asserted, and the test is skipped wherever the folder is absent.
 */
const dir = process.env.TAX_PAYMENT_FILES_DIR;
describe.skipIf(!dir || !existsSync(dir))('real exports (local only)', () => {
  it('every export in the folder is read whole', () => {
    const files = readdirSync(dir as string).filter((f) => /\.(csv|json)$/i.test(f));
    expect(files.length).toBeGreaterThan(0);
    const unread: string[] = [];
    let total = 0;
    files.forEach((name, index) => {
      try {
        total += parsePaymentFile(readFileSync(path.join(dir as string, name), 'utf-8')).payments.length;
      } catch (e) {
        // File position and error class only: no file name, no content.
        unread.push(`file ${index + 1}: ${e instanceof PaymentParseError ? `${e.code} row ${e.row}` : 'error'}`);
      }
    });
    expect(unread).toEqual([]);
    expect(total).toBeGreaterThan(0);
  });
});
