import { describe, expect, it } from 'vitest';
import { saveTaxSettings } from '@/lib/meals/service';
import { loadStatement } from '@/lib/tax/service';
import { createAccount, deleteAccount, deleteImportBatch, importPayments, loadPayments, PaymentServiceError, type PaymentContext } from '../../service';
import { type Aspsp, type BankApi, type PsuPresence, type SessionAccount, type StartInput } from '../client';
import { BankServiceError, bankNotices, completeConsent, disconnect, startConsent, syncConnection, type BankDeps } from '../service';
import { createWorkspace, db } from '../../../../../../test/db-helpers';

/**
 * The PayPal account continued live through the bank interface (plan
 * 2026-10-23-paypal-live), against a real database with a fake interface and
 * a fake rate cache. The four paths of the stateful-flow standard: forward;
 * an earlier input changed (a list imported after the live feed) with its
 * counter-case; resume (a rate that arrives on a later fetch); re-entry (back
 * to the file import, an account removed). Every name, code and amount is invented.
 */

const TODAY = '2026-10-23';
const NOW = new Date(`${TODAY}T08:00:00Z`);
const PAYPAL = { name: 'PayPal', country: 'DE' };
const OTHER_BANK = { name: 'Beispielbank', country: 'DE' };

type Tx = Record<string, unknown>;
/** A movement as PayPal gives it over the interface: transaction day only, no remittance text. */
const tx = (o: { day: string; cents: number; currency?: string; party?: string; code?: string; status?: string }): Tx => ({
  status: o.status ?? 'BOOK',
  transaction_date: o.day,
  transaction_amount: { amount: (Math.abs(o.cents) / 100).toFixed(2), currency: o.currency ?? 'EUR' },
  credit_debit_indicator: o.cents < 0 ? 'DBIT' : 'CRDT',
  bank_transaction_code: { description: 'invented' },
  ...(o.party === undefined ? {} : o.cents < 0 ? { creditor: { name: o.party } } : { debtor: { name: o.party } }),
  ...(o.code === undefined ? {} : { entry_reference: o.code }),
});

class FakePaypal implements BankApi {
  aspsps: Aspsp[] = [
    { name: PAYPAL.name, country: 'DE', maximumConsentValiditySeconds: 180 * 86_400, beta: false },
    { name: OTHER_BANK.name, country: 'DE', maximumConsentValiditySeconds: 90 * 86_400, beta: false },
  ];
  states: string[] = [];
  nextAccounts: SessionAccount[] = [{ uid: 'pp-uid', mask: null, name: 'PAYPAL_BUSINESS_ACCOUNT', currency: 'XXX' }];
  sessions = 0;
  rows: Tx[] = [];
  async listAspsps() {
    return this.aspsps;
  }
  async startAuthorization(input: StartInput) {
    this.states.push(input.state);
    return { url: 'https://paypal.example.test/consent' };
  }
  async createSession() {
    this.sessions++;
    return { sessionId: `pp-sess-${this.sessions}`, accounts: this.nextAccounts, validUntil: new Date('2027-04-20T08:00:00Z') };
  }
  async deleteSession() {}
  async fetchTransactions(_uid: string, from: string, to: string, _psu?: PsuPresence) {
    return this.rows.filter((t) => (t.transaction_date as string) >= from && (t.transaction_date as string) <= to);
  }
}

const HEADER =
  'Datum,Uhrzeit,Zeitzone,Name,Typ,Status,Währung,Brutto,Gebühr,Netto,Absender E-Mail-Adresse,Empfänger E-Mail-Adresse,Transaktionscode,Lieferadresse,Adress-Status,Artikelbezeichnung,Artikelnummer,Versand- und Bearbeitungsgebühr,Versicherungsbetrag,Umsatzsteuer,Option 1 Name,Option 1 Wert,Option 2 Name,Option 2 Wert,Zugehöriger Transaktionscode,Rechnungsnummer,Zollnummer,Anzahl,Empfangsnummer,Guthaben,Adresszeile 1,Adresszusatz,Ort,Bundesland,PLZ,Land,Telefon,Betreff,Hinweis,Ländervorwahl,Auswirkung auf Guthaben';
const csvRow = (o: { day: string; name: string; type?: string; currency?: string; gross: string; code: string; related?: string; effect?: string }) => {
  const cells = Array(41).fill('');
  const [y, m, d] = o.day.split('-');
  Object.assign(cells, { 0: `${d}.${m}.${y}`, 3: o.name, 4: o.type ?? 'PayPal Express-Zahlung', 5: 'Abgeschlossen', 6: o.currency ?? 'EUR', 7: o.gross, 12: o.code, 24: o.related ?? '', 40: o.effect ?? (o.gross.startsWith('-') ? 'Soll' : 'Haben') });
  return cells.map((c: string) => `"${c}"`).join(',');
};
/** A dollar purchase as the CSV lists it: the purchase, the euro conversion pointing at it, and the dollar side. */
const csvDollarPurchase = (o: { day: string; name: string; usd: string; eur: string; code: string }) => [
  csvRow({ day: o.day, name: o.name, currency: 'USD', gross: `-${o.usd}`, code: o.code }),
  csvRow({ day: o.day, name: '', type: 'Allgemeine Währungsumrechnung', gross: `-${o.eur}`, code: `${o.code}-EUR`, related: o.code }),
  csvRow({ day: o.day, name: '', type: 'Allgemeine Währungsumrechnung', currency: 'USD', gross: o.usd, code: `${o.code}-USD`, related: o.code, effect: 'Haben' }),
];
const csv = (...rows: string[]) => [HEADER, ...rows].join('\n');

const N26_HEADER = '"Booking Date","Value Date","Partner Name","Partner Iban",Type,"Payment Reference","Account Name","Amount (EUR)","Original Amount","Original Currency","Exchange Rate"';
const n26 = (...rows: Array<[string, string, string]>) => [N26_HEADER, ...rows.map(([day, partner, amount]) => `${day},${day},"${partner}",,Presentment,"",Hauptkonto,${amount},,,`)].join('\n') + '\n';

async function setup(options: { usdRate?: number | null } = {}) {
  const ws = await createWorkspace();
  const ctx: PaymentContext = { workspaceId: ws.workspaceId, tenantId: ws.tenantId };
  await saveTaxSettings(db, ctx, { smallBusiness: true });
  const walletId = await createAccount(db, ctx, { label: 'PayPal', kind: 'payment_service' });
  const bankId = await createAccount(db, ctx, { label: 'Girokonto', kind: 'bank' });
  const api = new FakePaypal();
  const rates = { usd: options.usdRate === undefined ? 0.9 : options.usdRate };
  const fxCalls: string[] = [];
  const deps: BankDeps = {
    api,
    redirectUrl: 'https://receipts.example.test/api/banking/callback',
    now: () => NOW,
    fxRate: async (currency, day) => {
      fxCalls.push(`${currency}|${day}`);
      return currency === 'USD' ? rates.usd : null;
    },
  };
  return { ws, ctx, walletId, bankId, api, deps, rates, fxCalls };
}

async function connectPaypal(s: Awaited<ReturnType<typeof setup>>) {
  await startConsent(db, s.ctx, s.deps, s.walletId, PAYPAL);
  const { connectionId } = await completeConsent(db, s.ctx.workspaceId, s.deps, { state: s.api.states[s.api.states.length - 1], code: 'ok' });
  return connectionId;
}

const errorCode = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    if (e instanceof BankServiceError || e instanceof PaymentServiceError) return e.code;
    throw e;
  }
  return 'no error';
};

const walletPayments = (accountId: string) => db.taxPayment.findMany({ where: { accountId }, orderBy: [{ bookingDay: 'asc' }, { amountCents: 'asc' }] });

/** The list up to 29 September: three purchases, the last one in dollars. Codes as PayPal numbers them. */
const LIST = csv(
  csvRow({ day: '2026-09-01', name: 'Kiosk Beispiel', gross: '-1,00', code: 'A1' }),
  csvRow({ day: '2026-09-15', name: 'Laden Beispiel', gross: '-19,99', code: 'A2' }),
  ...csvDollarPurchase({ day: '2026-09-29', name: 'Hosting Beispiel', usd: '10,00', eur: '9,41', code: 'PUR1' }),
);

/** What PayPal gives over the interface for the same weeks and after, with the same codes. */
const liveRows = () => [
  tx({ day: '2026-08-20', cents: -300, party: 'Alt Beispiel', code: 'Z1' }),
  tx({ day: '2026-09-15', cents: -1999, party: 'Laden Beispiel', code: 'A2' }),
  tx({ day: '2026-09-29', cents: -1000, currency: 'USD', party: 'Hosting Beispiel', code: 'PUR1' }),
  tx({ day: '2026-09-29', cents: -800, party: 'Kino Beispiel', code: 'A9' }),
  tx({ day: '2026-10-05', cents: -299, party: 'Musik Beispiel', code: 'B1' }),
  tx({ day: '2026-10-06', cents: -500, currency: 'USD', party: 'Server Beispiel', code: 'B2' }),
  // A top-up from the bank: no name.
  tx({ day: '2026-10-07', cents: 5000, code: 'B3' }),
  tx({ day: '2026-10-08', cents: -700, party: 'Abgelehnt Beispiel', code: 'B4', status: 'RJCT' }),
];

describe('PayPal live: forward', () => {
  it('the list keeps its days, the live feed continues and fills what the list does not hold, foreign purchases arrive as estimates', async () => {
    const s = await setup();
    await importPayments(db, s.ctx, s.walletId, LIST);
    await importPayments(db, s.ctx, s.bankId, n26(['2026-09-16', 'PayPal Europe S.a.r.l. et Cie S.C.A', '-19.99'], ['2026-10-06', 'PayPal Europe S.a.r.l. et Cie S.C.A', '-2.99'], ['2026-10-08', 'PayPal Europe S.a.r.l. et Cie S.C.A', '-50.00']));
    s.api.rows = liveRows();
    const connectionId = await connectPaypal(s);

    const result = await syncConnection(db, s.ctx, s.deps, connectionId, { today: TODAY });
    // New: the day before the list (Z1), the edge day's purchase the list lacks (A9), and the days after it.
    expect(result).toEqual({ status: 'synced', added: 5 });
    const stored = await walletPayments(s.walletId);
    expect(stored.map((p) => [p.bookingDay, p.amountCents, p.counterparty, p.amountEstimated])).toEqual([
      ['2026-08-20', -300, 'Alt Beispiel', false],
      ['2026-09-01', -100, 'Kiosk Beispiel', false],
      ['2026-09-15', -1999, 'Laden Beispiel', false],
      ['2026-09-29', -941, 'Hosting Beispiel', false],
      ['2026-09-29', -800, 'Kino Beispiel', false],
      ['2026-10-05', -299, 'Musik Beispiel', false],
      ['2026-10-06', -450, 'Server Beispiel', true],
      ['2026-10-07', 5000, '', false],
    ]);
    const server = stored.find((p) => p.entryReference === 'B2');
    expect(server).toMatchObject({ originalAmountCents: -500, originalCurrency: 'USD' });
    // The live import holds the service, so the account stays the PayPal wallet whatever happens to the list.
    const batches = await db.taxImportBatch.findMany({ where: { accountId: s.walletId }, orderBy: { createdAt: 'asc' } });
    expect(batches.map((b) => [b.format, b.service])).toEqual([
      ['paypal_csv', null],
      ['enable_banking_json', 'paypal'],
    ]);
    expect(s.fxCalls.sort()).toEqual(['USD|2026-09-29', 'USD|2026-10-06']);

    // The funding rule: every PayPal debit on the bank counts once; the top-up is no income.
    const loaded = await loadPayments(db, s.ctx.workspaceId);
    const byRef = (ref: string) => loaded.payments.find((p) => stored.find((x) => x.id === p.id)?.entryReference === ref);
    const bankRows = loaded.payments.filter((p) => p.accountId === s.bankId);
    expect(bankRows.map((p) => [p.bookingDay, p.kind])).toEqual([
      ['2026-09-16', 'own_transfer'],
      ['2026-10-06', 'own_transfer'],
      ['2026-10-08', 'own_transfer'],
    ]);
    expect(bankRows[0].funding?.twinId).toBe(byRef('A2')?.id);
    expect(bankRows[1].funding?.twinId).toBe(byRef('B1')?.id);
    expect(byRef('B3')?.kind).toBe('own_transfer');
    expect(byRef('B2')).toMatchObject({ estimated: true, original: { currency: 'USD', amountCents: -500 } });

    // The reconciliation of the service runs across the switch: list and live purchases are what it lists.
    const view = await loadStatement(db, s.ctx.workspaceId, 2026);
    const paypal = view.payments.reconciliations.find((r) => r.service === 'paypal');
    // Collected: the two purchases and the top-up the bank paid to PayPal.
    expect(paypal?.collectedCents).toBe(1999 + 299 + 5000);
    // List: 1.00 + 19.99 + 9.41; live: 3.00 + 8.00 + 2.99 + 4.50 (estimate). The top-up has no name and is no purchase.
    expect(paypal?.listedCents).toBe(100 + 1999 + 941 + 300 + 800 + 299 + 450);

    // A second fetch adds nothing and leaves no import behind.
    expect(await syncConnection(db, s.ctx, s.deps, connectionId, { today: TODAY })).toEqual({ status: 'nothing_new', added: 0 });
    expect(await db.taxImportBatch.count({ where: { accountId: s.walletId } })).toBe(2);
  });

  it('codes that differ between the sources: the day rule alone keeps every movement once, an estimate on the edge day included', async () => {
    const s = await setup();
    await importPayments(db, s.ctx, s.walletId, LIST);
    // Same movements, other codes.
    s.api.rows = liveRows().map((t) => ({ ...t, entry_reference: `X-${t.entry_reference as string}` }));
    const connectionId = await connectPaypal(s);
    expect(await syncConnection(db, s.ctx, s.deps, connectionId, { today: TODAY })).toEqual({ status: 'synced', added: 5 });
    const stored = await walletPayments(s.walletId);
    expect(stored).toHaveLength(8);
    // The dollar purchase on the list's last day is the list's: the estimate was compared by day and counterparty.
    expect(stored.filter((p) => p.counterparty === 'Hosting Beispiel').map((p) => [p.amountCents, p.amountEstimated])).toEqual([[-941, false]]);
  });
});

describe('PayPal live: an earlier input changed', () => {
  it('a list imported after the live feed gives estimates their real euro amount; the same list again changes nothing', async () => {
    const s = await setup();
    await importPayments(db, s.ctx, s.walletId, LIST);
    s.api.rows = liveRows();
    const connectionId = await connectPaypal(s);
    await syncConnection(db, s.ctx, s.deps, connectionId, { today: TODAY });

    const later = csv(
      csvRow({ day: '2026-10-05', name: 'Musik Beispiel', gross: '-2,99', code: 'B1' }),
      ...csvDollarPurchase({ day: '2026-10-06', name: 'Server Beispiel', usd: '5,00', eur: '4,71', code: 'B2' }),
      csvRow({ day: '2026-10-20', name: 'Neu Beispiel', gross: '-12,00', code: 'C1' }),
    );
    const result = await importPayments(db, s.ctx, s.walletId, later);
    expect(result).toMatchObject({ added: 1, settled: 1, skipped: expect.objectContaining({ known_from_other_source: 2 }) });
    const server = await db.taxPayment.findFirstOrThrow({ where: { accountId: s.walletId, entryReference: 'B2' } });
    expect(server).toMatchObject({ amountCents: -471, amountEstimated: false, originalAmountCents: -500, originalCurrency: 'USD' });
    const music = await db.taxPayment.findFirstOrThrow({ where: { accountId: s.walletId, entryReference: 'B1' } });
    expect(music.amountCents).toBe(-299);

    // Counter-case: the same list again is refused as a whole, and nothing changes.
    expect(await errorCode(importPayments(db, s.ctx, s.walletId, later))).toBe('file_already_imported');
    expect((await db.taxPayment.findFirstOrThrow({ where: { id: server.id } })).amountCents).toBe(-471);
    // A later fetch that sees the dollar purchase again keeps the real amount.
    expect(await syncConnection(db, s.ctx, s.deps, connectionId, { today: TODAY })).toMatchObject({ status: 'nothing_new' });
    expect((await db.taxPayment.findFirstOrThrow({ where: { id: server.id } })).amountCents).toBe(-471);
    expect(await db.taxPayment.count({ where: { accountId: s.walletId } })).toBe(9);
  });

  it('codes that differ: a later list gives the estimate on a live day its real amount by day and counterparty', async () => {
    const s = await setup();
    s.api.rows = [tx({ day: '2026-10-06', cents: -500, currency: 'USD', party: 'Server Beispiel', code: 'Y-B2' }), tx({ day: '2026-10-09', cents: -100, party: 'Kiosk Beispiel', code: 'Y-B5' })];
    const connectionId = await connectPaypal(s);
    await syncConnection(db, s.ctx, s.deps, connectionId, { today: TODAY });
    // The list's first and last day are 10-06 and 10-09, both edge days of the live range.
    const result = await importPayments(db, s.ctx, s.walletId, csv(...csvDollarPurchase({ day: '2026-10-06', name: 'Server Beispiel', usd: '5,00', eur: '4,71', code: 'B2' }), csvRow({ day: '2026-10-09', name: 'Kiosk Beispiel', gross: '-1,00', code: 'B5' })));
    expect(result.settled).toBe(1);
    expect(result.added).toBe(0);
    const stored = await walletPayments(s.walletId);
    expect(stored.map((p) => [p.bookingDay, p.amountCents, p.amountEstimated])).toEqual([
      ['2026-10-06', -471, false],
      ['2026-10-09', -100, false],
    ]);
  });
});

describe('PayPal live: resume', () => {
  it('a movement without a rate waits as a notice; the next fetch with the rate imports it and the notice goes', async () => {
    const s = await setup({ usdRate: null });
    s.api.rows = [tx({ day: '2026-10-06', cents: -500, currency: 'USD', party: 'Server Beispiel', code: 'B2' }), tx({ day: '2026-10-20', cents: -100, party: 'Kiosk Beispiel', code: 'B6' })];
    const connectionId = await connectPaypal(s);
    expect(await syncConnection(db, s.ctx, s.deps, connectionId, { today: TODAY })).toEqual({ status: 'synced', added: 1 });
    let c = await db.taxBankConnection.findUniqueOrThrow({ where: { id: connectionId } });
    expect(bankNotices(c.notices).unrated).toEqual(['2026-10-06']);
    // The next fetch reaches back to that day, not twelve days before the last booking.
    expect(c.lastBookedThrough! <= '2026-10-17').toBe(true);

    s.rates.usd = 0.9;
    expect(await syncConnection(db, s.ctx, s.deps, connectionId, { today: TODAY })).toEqual({ status: 'synced', added: 1 });
    c = await db.taxBankConnection.findUniqueOrThrow({ where: { id: connectionId } });
    expect(bankNotices(c.notices).unrated).toEqual([]);
    expect(c.lastBookedThrough).toBe('2026-10-20');
    expect((await db.taxPayment.findFirstOrThrow({ where: { accountId: s.walletId, entryReference: 'B2' } })).amountCents).toBe(-450);
  });

  it('a renewed consent continues where the last fetch stopped and stays PayPal-only', async () => {
    const s = await setup();
    s.api.rows = [tx({ day: '2026-10-05', cents: -299, party: 'Musik Beispiel', code: 'B1' })];
    await connectPaypal(s);
    const connection = await db.taxBankConnection.findUniqueOrThrow({ where: { accountId: s.walletId } });
    await syncConnection(db, s.ctx, s.deps, connection.id, { today: TODAY });
    expect(await errorCode(startConsent(db, s.ctx, s.deps, s.walletId, OTHER_BANK))).toBe('institution_mismatch');
    await connectPaypal(s);
    const renewed = await db.taxBankConnection.findUniqueOrThrow({ where: { accountId: s.walletId } });
    expect(renewed).toMatchObject({ status: 'active', sessionId: 'pp-sess-2', lastBookedThrough: '2026-10-05' });
  });
});

describe('PayPal live: re-entry', () => {
  it('back to the file import: the connection ends, the account stays the wallet, a newer list adds only what is new', async () => {
    const s = await setup();
    s.api.rows = [tx({ day: '2026-10-05', cents: -299, party: 'Musik Beispiel', code: 'B1' }), tx({ day: '2026-10-06', cents: -500, currency: 'USD', party: 'Server Beispiel', code: 'B2' })];
    const connectionId = await connectPaypal(s);
    await syncConnection(db, s.ctx, s.deps, connectionId, { today: TODAY });
    await disconnect(db, s.ctx, s.deps, connectionId);
    expect(await db.taxBankConnection.count({ where: { accountId: s.walletId } })).toBe(0);

    await importPayments(db, s.ctx, s.bankId, n26(['2026-10-06', 'PayPal Europe', '-2.99']));
    const loaded = await loadPayments(db, s.ctx.workspaceId);
    expect(loaded.payments.find((p) => p.accountId === s.bankId)?.kind).toBe('own_transfer');

    const result = await importPayments(db, s.ctx, s.walletId, csv(csvRow({ day: '2026-10-05', name: 'Musik Beispiel', gross: '-2,99', code: 'B1' }), ...csvDollarPurchase({ day: '2026-10-06', name: 'Server Beispiel', usd: '5,00', eur: '4,71', code: 'B2' }), csvRow({ day: '2026-10-21', name: 'Neu Beispiel', gross: '-5,00', code: 'C2' })));
    expect(result).toMatchObject({ added: 1, settled: 1 });
    expect(await db.taxPayment.count({ where: { accountId: s.walletId } })).toBe(3);
  });

  it('a live import undone is fetched again; the list cannot be undone while the live import relies on its days', async () => {
    const s = await setup();
    await importPayments(db, s.ctx, s.walletId, LIST);
    s.api.rows = liveRows();
    const connectionId = await connectPaypal(s);
    await syncConnection(db, s.ctx, s.deps, connectionId, { today: TODAY });
    const [listBatch, liveBatch] = await db.taxImportBatch.findMany({ where: { accountId: s.walletId }, orderBy: { createdAt: 'asc' } });
    expect(await errorCode(deleteImportBatch(db, s.ctx, listBatch.id))).toBe('batch_has_later_source');
    await deleteImportBatch(db, s.ctx, liveBatch.id);
    expect(await db.taxPayment.count({ where: { accountId: s.walletId } })).toBe(3);
    // The next fetch starts afresh from the last booked day it remembers; reset it like a new binding would.
    await db.taxBankConnection.update({ where: { id: connectionId }, data: { lastBookedThrough: null } });
    expect(await syncConnection(db, s.ctx, s.deps, connectionId, { today: TODAY })).toEqual({ status: 'synced', added: 5 });
    expect(await db.taxPayment.count({ where: { accountId: s.walletId } })).toBe(8);
  });
});

describe('PayPal live: which institution may continue which account', () => {
  it('PayPal list only PayPal, a bank only a bank, the pay-later list nothing; an empty account any', async () => {
    const s = await setup();
    await importPayments(db, s.ctx, s.walletId, LIST);
    expect(await errorCode(startConsent(db, s.ctx, s.deps, s.walletId, OTHER_BANK))).toBe('institution_mismatch');
    expect(await errorCode(startConsent(db, s.ctx, s.deps, s.walletId, PAYPAL))).toBe('no error');

    await importPayments(db, s.ctx, s.bankId, n26(['2026-10-01', 'Laden Beispiel', '-1.00']));
    expect(await errorCode(startConsent(db, s.ctx, s.deps, s.bankId, PAYPAL))).toBe('institution_mismatch');
    expect(await errorCode(startConsent(db, s.ctx, s.deps, s.bankId, OTHER_BANK))).toBe('no error');

    const later = await createAccount(db, s.ctx, { label: 'Klarna', kind: 'payment_service' });
    await importPayments(db, s.ctx, later, 'created_date,created_time,timezone,amount,currency,merchant,status,payment_reference,items\n2026-10-02,10:00,Europe/Berlin,12.00,EUR,Laden Beispiel,Bezahlt,K-1,Ding\n');
    expect(await errorCode(startConsent(db, s.ctx, s.deps, later, PAYPAL))).toBe('account_source_unsupported');

    const empty = await createAccount(db, s.ctx, { label: 'Leer', kind: 'payment_service' });
    expect(await errorCode(startConsent(db, s.ctx, s.deps, empty, PAYPAL))).toBe('no error');
  });

  it('a bank list uploaded by hand onto the PayPal account is refused: only the live feed reading PayPal continues it', async () => {
    const s = await setup();
    await importPayments(db, s.ctx, s.walletId, LIST);
    expect(await errorCode(importPayments(db, s.ctx, s.walletId, JSON.stringify({ transactions: [tx({ day: '2026-10-05', cents: -299, party: 'Musik Beispiel', code: 'B1' })] })))).toBe('format_mismatch');
  });
});

describe('Konto entfernen', () => {
  it('only an account without payments, imports and connection, only in its own company; the name is free again', async () => {
    const s = await setup();
    const other = await createWorkspace();
    await importPayments(db, s.ctx, s.walletId, LIST);
    expect(await errorCode(deleteAccount(db, s.ctx, s.walletId))).toBe('account_not_empty');

    const pending = await createAccount(db, s.ctx, { label: 'Wartet', kind: 'payment_service' });
    await startConsent(db, s.ctx, s.deps, pending, PAYPAL);
    expect(await errorCode(deleteAccount(db, s.ctx, pending))).toBe('account_not_empty');

    const empty = await createAccount(db, s.ctx, { label: 'Altes Konto', kind: 'bank' });
    expect(await errorCode(deleteAccount(db, { workspaceId: other.workspaceId, tenantId: other.tenantId }, empty))).toBe('account_not_found');
    await deleteAccount(db, s.ctx, empty);
    expect(await db.taxAccount.count({ where: { id: empty } })).toBe(0);
    expect(await errorCode(deleteAccount(db, s.ctx, empty))).toBe('account_not_found');
    // Re-entry: an account of the same name can be created again.
    expect(await createAccount(db, s.ctx, { label: 'Altes Konto', kind: 'bank' })).toBeTruthy();
  });

  it('an account whose imports were all undone is empty again and can be removed', async () => {
    const s = await setup();
    const result = await importPayments(db, s.ctx, s.walletId, LIST);
    await deleteImportBatch(db, s.ctx, result.batchId);
    await deleteAccount(db, s.ctx, s.walletId);
    expect(await db.taxAccount.count({ where: { id: s.walletId } })).toBe(0);
  });
});
