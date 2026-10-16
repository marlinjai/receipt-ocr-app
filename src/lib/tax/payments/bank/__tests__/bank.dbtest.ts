import { beforeAll, describe, expect, it } from 'vitest';
import { saveTaxSettings } from '@/lib/meals/service';
import { createAccount, importPayments, loadPayments, type PaymentContext } from '../../service';
import { BankApiError, type Aspsp, type BankApi, type SessionAccount, type StartInput } from '../client';
import {
  BankServiceError,
  chooseBankAccount,
  completeConsent,
  disconnect,
  loadBankConnections,
  startConsent,
  syncAllConnections,
  syncConnection,
  type BankDeps,
} from '../service';
import { createWorkspace, db } from '../../../../../../test/db-helpers';

/**
 * The live bank connection against a real database, with a fake bank
 * interface. The four paths of the stateful-flow standard: forward, change of
 * an earlier input, resume, re-entry after failure; and workspace isolation.
 * Every institution, account, name and amount is invented.
 */

const TODAY = '2026-10-16';
const NOW = new Date(`${TODAY}T08:00:00Z`);
const BANK = { name: 'Beispielbank', country: 'DE' };

type Tx = Record<string, unknown>;
const tx = (day: string, cents: number, party: string, text: string, status = 'BOOK'): Tx => ({
  status,
  booking_date: day,
  value_date: day,
  transaction_amount: { amount: (Math.abs(cents) / 100).toFixed(2), currency: 'EUR' },
  credit_debit_indicator: cents < 0 ? 'DBIT' : 'CRDT',
  ...(cents < 0 ? { creditor: { name: party } } : { debtor: { name: party } }),
  remittance_information: [text],
});

/** A bank interface that remembers what it was asked and answers from what a test set up. */
class FakeBank implements BankApi {
  aspsps: Aspsp[] = [{ name: BANK.name, country: 'DE', maximumConsentValiditySeconds: 90 * 86_400, beta: false }];
  states: string[] = [];
  starts: StartInput[] = [];
  /** The accounts the next session gives. */
  nextAccounts: SessionAccount[] = [{ uid: 'uid-a1', mask: '•••• 1111', name: 'Girokonto', currency: 'EUR' }];
  sessionCount = 0;
  deleted: string[] = [];
  transactions = new Map<string, Tx[]>();
  failNext: BankApiError | null = null;
  failFor = new Map<string, BankApiError>();
  fetchCalls: Array<{ uid: string; from: string; to: string }> = [];

  async listAspsps() {
    return this.aspsps;
  }
  async startAuthorization(input: StartInput) {
    this.starts.push(input);
    this.states.push(input.state);
    return { url: 'https://bank.example.test/consent' };
  }
  async createSession(code: string) {
    if (code === 'bad') throw new BankApiError('authorization_code', 'WRONG_AUTHORIZATION_CODE', 400);
    this.sessionCount++;
    return { sessionId: `sess-${this.sessionCount}`, accounts: this.nextAccounts, validUntil: new Date('2027-01-14T08:00:00Z') };
  }
  async deleteSession(id: string) {
    this.deleted.push(id);
  }
  async fetchTransactions(uid: string, from: string, to: string) {
    this.fetchCalls.push({ uid, from, to });
    const always = this.failFor.get(uid);
    if (always) throw always;
    if (this.failNext) {
      const e = this.failNext;
      this.failNext = null;
      throw e;
    }
    return (this.transactions.get(uid) ?? []).filter((t) => (t.booking_date as string) >= from && (t.booking_date as string) <= to);
  }
  get lastState() {
    return this.states[this.states.length - 1];
  }
}

async function setup(label = 'Girokonto Beispielbank', shared?: FakeBank) {
  const ws = await createWorkspace();
  const ctx: PaymentContext = { workspaceId: ws.workspaceId, tenantId: ws.tenantId };
  await saveTaxSettings(db, ctx, { smallBusiness: true });
  const accountId = await createAccount(db, ctx, { label, kind: 'bank' });
  const bank = shared ?? new FakeBank();
  let clock = NOW;
  const deps: BankDeps = { api: bank, redirectUrl: 'https://receipts.example.test/api/bank/callback', now: () => clock };
  return { ws, ctx, accountId, bank, deps, setClock: (d: Date) => (clock = d) };
}

/** Consent and callback in one go; returns the connection id. */
async function connect(s: Awaited<ReturnType<typeof setup>>) {
  await startConsent(db, s.ctx, s.deps, s.accountId, BANK);
  const { connectionId } = await completeConsent(db, s.ctx.workspaceId, s.deps, { state: s.bank.lastState, code: 'ok' });
  return connectionId;
}

const code = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    if (e instanceof BankServiceError) return e.detail ? `${e.code}:${e.detail}` : e.code;
    throw e;
  }
  return 'no error';
};

const connectionOf = (accountId: string) => db.taxBankConnection.findUniqueOrThrow({ where: { accountId } });
const paymentCount = (accountId: string) => db.taxPayment.count({ where: { accountId } });
const batchCount = (accountId: string) => db.taxImportBatch.count({ where: { accountId } });

const N26_HEADER = '"Booking Date","Value Date","Partner Name","Partner Iban",Type,"Payment Reference","Account Name","Amount (EUR)","Original Amount","Original Currency","Exchange Rate"';
const n26 = (...rows: Array<[string, string, string, string]>) =>
  [N26_HEADER, ...rows.map(([day, partner, ref, amount]) => `${day},${day},"${partner}",,Presentment,"${ref}",Hauptkonto,${amount},,,`)].join('\n') + '\n';

describe('bank connection: forward', () => {
  it('consent, callback with one account, and a sync that adds the booked movements', async () => {
    const s = await setup();
    s.bank.transactions.set('uid-a1', [
      tx('2026-09-01', -1999, 'Werkzeug Beispiel GmbH', 'Bestellung 1'),
      tx('2026-09-15', 50000, 'Kundin Beispiel', 'Rechnung R-1'),
      tx('2026-10-15', -500, 'Café Beispiel', 'Kaffee', 'PDNG'),
    ]);
    await startConsent(db, s.ctx, s.deps, s.accountId, BANK);
    const start = s.bank.starts[0];
    // The consent lasts what the institution allows (90 days here), never more than 180.
    expect(start.validUntil.toISOString()).toBe(new Date(NOW.getTime() + 90 * 86_400_000).toISOString());
    expect(start.redirectUrl).toBe('https://receipts.example.test/api/bank/callback');
    let c = await connectionOf(s.accountId);
    expect(c.status).toBe('pending');
    expect(c.stateHash).not.toBe(start.state);
    expect(c.stateHash).toHaveLength(64);

    const done = await completeConsent(db, s.ctx.workspaceId, s.deps, { state: start.state, code: 'ok' });
    expect(done.outcome).toBe('connected');
    c = await connectionOf(s.accountId);
    expect(c).toMatchObject({ status: 'active', sessionId: 'sess-1', accountUid: 'uid-a1', boundMask: '•••• 1111', stateHash: null });

    const result = await syncConnection(db, s.ctx, s.deps, c.id, { today: TODAY });
    expect(result).toEqual({ status: 'synced', added: 2 });
    // The first fetch reaches back 89 days.
    expect(s.bank.fetchCalls[0]).toEqual({ uid: 'uid-a1', from: '2026-07-19', to: TODAY });
    c = await connectionOf(s.accountId);
    expect(c.lastBookedThrough).toBe('2026-09-15');
    expect(c.lastSyncedAt?.toISOString()).toBe(NOW.toISOString());
    const loaded = await loadPayments(db, s.ctx.workspaceId);
    expect(loaded.payments.map((p) => [p.bookingDay, p.amountCents])).toEqual([
      ['2026-09-01', -1999],
      ['2026-09-15', 50000],
    ]);
    const view = await loadBankConnections(db, s.ctx.workspaceId, NOW);
    expect(view[0]).toMatchObject({ status: 'active', aspspName: BANK.name, lastBookedThrough: '2026-09-15', renewSoon: false });
  });

  it('a session with several accounts asks which one, and the choice binds it', async () => {
    const s = await setup();
    s.bank.nextAccounts = [
      { uid: 'uid-1', mask: '•••• 1111', name: 'Girokonto', currency: 'EUR' },
      { uid: 'uid-2', mask: '•••• 2222', name: 'Tagesgeld', currency: 'EUR' },
    ];
    await startConsent(db, s.ctx, s.deps, s.accountId, BANK);
    expect((await completeConsent(db, s.ctx.workspaceId, s.deps, { state: s.bank.lastState, code: 'ok' })).outcome).toBe('choose_account');
    let c = await connectionOf(s.accountId);
    expect(c.status).toBe('choose_account');
    expect(await syncConnection(db, s.ctx, s.deps, c.id, { today: TODAY })).toEqual({ status: 'not_active', added: 0 });
    expect(JSON.stringify(c.candidates)).not.toMatch(/DE\d{2}/);
    expect(await code(chooseBankAccount(db, s.ctx, c.id, 'uid-unknown'))).toBe('invalid_choice');
    await chooseBankAccount(db, s.ctx, c.id, 'uid-2');
    c = await connectionOf(s.accountId);
    expect(c).toMatchObject({ status: 'active', accountUid: 'uid-2', boundMask: '•••• 2222', boundName: 'Tagesgeld' });
  });

  it('the daily run syncs every active connection of every workspace, one failing bank stopping none', async () => {
    const shared = new FakeBank();
    const a = await setup('Girokonto A', shared);
    const b = await setup('Girokonto B', shared);
    shared.nextAccounts = [{ uid: 'uid-run-a', mask: '•••• 1111', name: 'Girokonto', currency: 'EUR' }];
    const ca = await connect(a);
    shared.nextAccounts = [{ uid: 'uid-run-b', mask: '•••• 2222', name: 'Girokonto', currency: 'EUR' }];
    const cb = await connect(b);
    shared.transactions.set('uid-run-a', [tx('2026-10-01', -1000, 'Händler A', 'Kauf')]);
    shared.failFor.set('uid-run-b', new BankApiError('bank_unavailable', 'ASPSP_ERROR', 500));
    const touched: string[] = [];
    const results = await syncAllConnections(db, a.deps, {
      today: TODAY,
      afterNewPayments: async (ctx) => {
        touched.push(ctx.workspaceId);
        throw new Error('checks failing is only logged');
      },
    });
    expect(results.find((r) => r.connectionId === ca)).toMatchObject({ status: 'synced', added: 1 });
    expect(results.find((r) => r.connectionId === cb)).toMatchObject({ status: 'failed', added: 0 });
    expect(touched).toContain(a.ctx.workspaceId);
    expect(touched).not.toContain(b.ctx.workspaceId);
    expect((await connectionOf(b.accountId)).lastError).toBe('bank_unavailable');
    // The answer carries counts only.
    expect(JSON.stringify(results)).not.toContain('Händler');
  });
});

describe('bank connection: an earlier input changes', () => {
  it('renewal keeps the account, its imports and its last day; the old session is closed', async () => {
    const s = await setup();
    s.bank.transactions.set('uid-a1', [tx('2026-09-01', -1999, 'Werkzeug Beispiel GmbH', 'Bestellung 1')]);
    const id = await connect(s);
    await syncConnection(db, s.ctx, s.deps, id, { today: TODAY });
    // The renewed session names the same bank account under a new uid.
    s.bank.nextAccounts = [
      { uid: 'uid-new', mask: '•••• 1111', name: 'Girokonto', currency: 'EUR' },
      { uid: 'uid-other', mask: '•••• 9999', name: 'Tagesgeld', currency: 'EUR' },
    ];
    s.bank.transactions.set('uid-new', [tx('2026-09-01', -1999, 'Werkzeug Beispiel GmbH', 'Bestellung 1'), tx('2026-10-02', -700, 'Bäckerei Beispiel', 'Brot')]);
    await startConsent(db, s.ctx, s.deps, s.accountId, BANK);
    // While the renewal is open, the old session keeps working.
    expect((await connectionOf(s.accountId)).status).toBe('active');
    const done = await completeConsent(db, s.ctx.workspaceId, s.deps, { state: s.bank.lastState, code: 'ok' });
    expect(done).toEqual({ connectionId: id, outcome: 'connected' });
    const c = await connectionOf(s.accountId);
    expect(c).toMatchObject({ status: 'active', sessionId: 'sess-2', accountUid: 'uid-new', lastBookedThrough: '2026-09-01' });
    expect(s.bank.deleted).toEqual(['sess-1']);
    expect(await syncConnection(db, s.ctx, s.deps, id, { today: TODAY })).toEqual({ status: 'synced', added: 1 });
    // The fetch continues five days before the last booked day.
    expect(s.bank.fetchCalls.at(-1)).toMatchObject({ uid: 'uid-new', from: '2026-08-27' });
    expect(await paymentCount(s.accountId)).toBe(2);
  });

  it('an abandoned renewal at another institution changes nothing that syncs', async () => {
    const s = await setup();
    s.bank.aspsps.push({ name: 'Zweitbank', country: 'DE', maximumConsentValiditySeconds: null, beta: false });
    const id = await connect(s);
    await startConsent(db, s.ctx, s.deps, s.accountId, { name: 'Zweitbank', country: 'DE' });
    // No limit given: 180 days.
    expect(s.bank.starts.at(-1)!.validUntil.toISOString()).toBe(new Date(NOW.getTime() + 180 * 86_400_000).toISOString());
    const view = (await loadBankConnections(db, s.ctx.workspaceId, NOW))[0];
    expect(view).toMatchObject({ id, status: 'active', aspspName: BANK.name, pendingAspspName: 'Zweitbank' });
  });

  it('choosing another account of the session starts that account afresh', async () => {
    const s = await setup();
    s.bank.nextAccounts = [
      { uid: 'uid-1', mask: '•••• 1111', name: 'Girokonto', currency: 'EUR' },
      { uid: 'uid-2', mask: '•••• 2222', name: 'Tagesgeld', currency: 'EUR' },
    ];
    await startConsent(db, s.ctx, s.deps, s.accountId, BANK);
    const { connectionId } = await completeConsent(db, s.ctx.workspaceId, s.deps, { state: s.bank.lastState, code: 'ok' });
    await chooseBankAccount(db, s.ctx, connectionId, 'uid-1');
    s.bank.transactions.set('uid-1', [tx('2026-10-01', -100, 'A', 'a')]);
    await syncConnection(db, s.ctx, s.deps, connectionId, { today: TODAY });
    expect((await connectionOf(s.accountId)).lastBookedThrough).toBe('2026-10-01');
    await chooseBankAccount(db, s.ctx, connectionId, 'uid-2');
    expect(await connectionOf(s.accountId)).toMatchObject({ accountUid: 'uid-2', lastBookedThrough: null });
    // Back to the first keeps nothing stale either: it was reset by the switch and starts at 89 days again.
    await chooseBankAccount(db, s.ctx, connectionId, 'uid-1');
    await syncConnection(db, s.ctx, s.deps, connectionId, { today: TODAY });
    expect(s.bank.fetchCalls.at(-1)).toMatchObject({ uid: 'uid-1', from: '2026-07-19' });
    expect(await paymentCount(s.accountId)).toBe(1);
  });

  it('disconnect keeps the payments; connecting again stores nothing twice and leaves no empty import', async () => {
    const s = await setup();
    s.bank.transactions.set('uid-a1', [tx('2026-09-01', -1999, 'Werkzeug Beispiel GmbH', 'Bestellung 1'), tx('2026-09-02', -1999, 'Werkzeug Beispiel GmbH', 'Bestellung 1')]);
    const id = await connect(s);
    await syncConnection(db, s.ctx, s.deps, id, { today: TODAY });
    expect(await disconnect(db, s.ctx, s.deps, id)).toEqual({ closedAtBank: true });
    expect(s.bank.deleted).toContain('sess-1');
    expect(await db.taxBankConnection.count({ where: { accountId: s.accountId } })).toBe(0);
    expect(await paymentCount(s.accountId)).toBe(2);
    const batches = await batchCount(s.accountId);
    s.bank.nextAccounts = [{ uid: 'uid-b', mask: '•••• 1111', name: 'Girokonto', currency: 'EUR' }];
    s.bank.transactions.set('uid-b', s.bank.transactions.get('uid-a1')!);
    const again = await connect(s);
    expect(await syncConnection(db, s.ctx, s.deps, again, { today: TODAY })).toEqual({ status: 'nothing_new', added: 0 });
    expect(await paymentCount(s.accountId)).toBe(2);
    expect(await batchCount(s.accountId)).toBe(batches);
  });

  it('a file import of the same account before and after a sync keeps every movement once', async () => {
    const s = await setup();
    // The export covers 1 to 20 August.
    await importPayments(db, s.ctx, s.accountId, n26(['2026-08-01', 'Laden Beispiel', 'Kauf 1', '-10.00'], ['2026-08-05', 'Werkzeug Beispiel GmbH', 'Bestellung 2', '-20.00'], ['2026-08-20', 'Laden Beispiel', 'Kauf 3', '-30.00']));
    // The bank describes the same movements in its own words, plus a new one in September.
    s.bank.transactions.set('uid-a1', [
      tx('2026-08-01', -1000, 'LADEN BEISPIEL', 'Kartenzahlung'),
      tx('2026-08-05', -2000, 'WERKZEUG BEISPIEL', 'Lastschrift'),
      tx('2026-08-20', -3000, 'LADEN BEISPIEL', 'Kartenzahlung'),
      tx('2026-09-10', -4000, 'Versand Beispiel', 'Paket'),
    ]);
    const id = await connect(s);
    expect(await syncConnection(db, s.ctx, s.deps, id, { today: TODAY })).toEqual({ status: 'synced', added: 1 });
    expect(await paymentCount(s.accountId)).toBe(4);
    // A later export of September repeats the movement the bank brought, and adds one.
    await importPayments(db, s.ctx, s.accountId, n26(['2026-09-10', 'Versand Beispiel', 'Paket 77', '-40.00'], ['2026-09-25', 'Händler Beispiel', 'Kauf 4', '-50.00']));
    expect(await paymentCount(s.accountId)).toBe(5);
    // And the next fetch of the same days adds nothing.
    expect(await syncConnection(db, s.ctx, s.deps, id, { today: TODAY })).toEqual({ status: 'nothing_new', added: 0 });
    expect(await paymentCount(s.accountId)).toBe(5);
  });
});

describe('bank connection: resume', () => {
  it('a replayed, a wrong and an expired answer from the bank are refused', async () => {
    const s = await setup();
    await startConsent(db, s.ctx, s.deps, s.accountId, BANK);
    const state = s.bank.lastState;
    expect(await code(completeConsent(db, s.ctx.workspaceId, s.deps, { state: 'wrong-state', code: 'ok' }))).toBe('state_invalid');
    expect(await code(completeConsent(db, s.ctx.workspaceId, s.deps, { state: null, code: 'ok' }))).toBe('state_invalid');
    await completeConsent(db, s.ctx.workspaceId, s.deps, { state, code: 'ok' });
    expect(await code(completeConsent(db, s.ctx.workspaceId, s.deps, { state, code: 'ok' }))).toBe('state_invalid');
    expect(s.bank.sessionCount).toBe(1);

    const t = await setup();
    await startConsent(db, t.ctx, t.deps, t.accountId, BANK);
    t.setClock(new Date(NOW.getTime() + 31 * 60_000));
    expect(await code(completeConsent(db, t.ctx.workspaceId, t.deps, { state: t.bank.lastState, code: 'ok' }))).toBe('state_expired');
    expect(await connectionOf(t.accountId)).toMatchObject({ status: 'error', lastError: 'consent_timed_out', stateHash: null });
    expect(t.bank.sessionCount).toBe(0);
  });

  it('a cancelled consent and a bad code are recorded; starting again works', async () => {
    const s = await setup();
    await startConsent(db, s.ctx, s.deps, s.accountId, BANK);
    expect(await code(completeConsent(db, s.ctx.workspaceId, s.deps, { state: s.bank.lastState, error: 'access_denied' }))).toBe('bank_error:consent_refused');
    expect(await connectionOf(s.accountId)).toMatchObject({ status: 'error', lastError: 'consent_refused' });
    await startConsent(db, s.ctx, s.deps, s.accountId, BANK);
    expect(await code(completeConsent(db, s.ctx.workspaceId, s.deps, { state: s.bank.lastState, code: 'bad' }))).toBe('bank_error:authorization_code');
    await startConsent(db, s.ctx, s.deps, s.accountId, BANK);
    await completeConsent(db, s.ctx.workspaceId, s.deps, { state: s.bank.lastState, code: 'ok' });
    expect(await connectionOf(s.accountId)).toMatchObject({ status: 'active', lastError: null });
  });

  it('a sync run twice adds nothing the second time and leaves no empty import', async () => {
    const s = await setup();
    s.bank.transactions.set('uid-a1', [tx('2026-10-01', -1000, 'A', 'a'), tx('2026-10-14', -1000, 'B', 'b', 'PDNG')]);
    const id = await connect(s);
    expect((await syncConnection(db, s.ctx, s.deps, id, { today: TODAY })).added).toBe(1);
    const batches = await batchCount(s.accountId);
    expect(await syncConnection(db, s.ctx, s.deps, id, { today: TODAY })).toEqual({ status: 'nothing_new', added: 0 });
    // Only pending movements in the window: still nothing stored.
    s.bank.transactions.set('uid-a1', [tx('2026-10-14', -1000, 'B', 'b', 'PDNG')]);
    expect(await syncConnection(db, s.ctx, s.deps, id, { today: TODAY })).toEqual({ status: 'nothing_new', added: 0 });
    // Nothing at all in the window.
    s.bank.transactions.set('uid-a1', []);
    expect(await syncConnection(db, s.ctx, s.deps, id, { today: TODAY })).toEqual({ status: 'nothing_new', added: 0 });
    expect(await batchCount(s.accountId)).toBe(batches);
    expect((await connectionOf(s.accountId)).lastBookedThrough).toBe('2026-10-01');
  });
});

describe('bank connection: re-entry after a failure', () => {
  it('an expired session keeps the data, renewal brings it back, and the next sync continues', async () => {
    const s = await setup();
    s.bank.transactions.set('uid-a1', [tx('2026-09-20', -1000, 'A', 'a')]);
    const id = await connect(s);
    await syncConnection(db, s.ctx, s.deps, id, { today: TODAY });
    s.bank.failNext = new BankApiError('session_expired', 'EXPIRED_SESSION', 422);
    expect(await syncConnection(db, s.ctx, s.deps, id, { today: TODAY })).toEqual({ status: 'expired', added: 0 });
    expect(await connectionOf(s.accountId)).toMatchObject({ status: 'expired', lastError: 'session_expired', lastBookedThrough: '2026-09-20' });
    expect(await paymentCount(s.accountId)).toBe(1);
    expect(await syncConnection(db, s.ctx, s.deps, id, { today: TODAY })).toEqual({ status: 'not_active', added: 0 });
    // Renewal: same account in the new session.
    s.bank.nextAccounts = [{ uid: 'uid-r', mask: '•••• 1111', name: 'Girokonto', currency: 'EUR' }];
    s.bank.transactions.set('uid-r', [tx('2026-09-20', -1000, 'A', 'a'), tx('2026-10-10', -2000, 'B', 'b')]);
    await startConsent(db, s.ctx, s.deps, s.accountId, BANK);
    await completeConsent(db, s.ctx.workspaceId, s.deps, { state: s.bank.lastState, code: 'ok' });
    expect(await syncConnection(db, s.ctx, s.deps, id, { today: TODAY })).toEqual({ status: 'synced', added: 1 });
    expect(s.bank.fetchCalls.at(-1)).toMatchObject({ from: '2026-09-15' });
  });

  it('a revoked session is marked revoked', async () => {
    const s = await setup();
    const id = await connect(s);
    s.bank.failNext = new BankApiError('session_revoked', 'REVOKED_SESSION', 422);
    expect((await syncConnection(db, s.ctx, s.deps, id, { today: TODAY })).status).toBe('revoked');
    expect((await loadBankConnections(db, s.ctx.workspaceId, NOW))[0].status).toBe('revoked');
  });

  it('a rate limit keeps the connection active and the next run works', async () => {
    const s = await setup();
    s.bank.transactions.set('uid-a1', [tx('2026-10-01', -1000, 'A', 'a')]);
    const id = await connect(s);
    s.bank.failNext = new BankApiError('rate_limited', 'ASPSP_RATE_LIMIT_EXCEEDED', 429);
    expect(await syncConnection(db, s.ctx, s.deps, id, { today: TODAY })).toEqual({ status: 'rate_limited', added: 0 });
    expect(await connectionOf(s.accountId)).toMatchObject({ status: 'active', lastError: 'rate_limited' });
    expect(await syncConnection(db, s.ctx, s.deps, id, { today: TODAY })).toEqual({ status: 'synced', added: 1 });
    expect(await connectionOf(s.accountId)).toMatchObject({ status: 'active', lastError: null });
  });

  it('a bank error is visible, a failed import too, and both clear on success', async () => {
    const s = await setup();
    const id = await connect(s);
    s.bank.failNext = new BankApiError('bank_unavailable', 'ASPSP_ERROR', 500);
    expect(await syncConnection(db, s.ctx, s.deps, id, { today: TODAY })).toEqual({ status: 'failed', added: 0, error: 'bank_unavailable' });
    expect((await loadBankConnections(db, s.ctx.workspaceId, NOW))[0]).toMatchObject({ status: 'active', lastError: 'bank_unavailable' });
    // An unreadable movement rejects the whole fetch: nothing is stored, and it says so.
    s.bank.transactions.set('uid-a1', [{ status: 'BOOK', booking_date: '2026-10-01', transaction_amount: { amount: 'zehn', currency: 'EUR' }, credit_debit_indicator: 'DBIT' }]);
    expect(await syncConnection(db, s.ctx, s.deps, id, { today: TODAY })).toEqual({ status: 'failed', added: 0, error: 'parse_unreadable_row' });
    expect(await paymentCount(s.accountId)).toBe(0);
    s.bank.transactions.set('uid-a1', [tx('2026-10-01', -1000, 'A', 'a')]);
    expect(await syncConnection(db, s.ctx, s.deps, id, { today: TODAY })).toEqual({ status: 'synced', added: 1 });
    expect((await connectionOf(s.accountId)).lastError).toBeNull();
  });

  it('a consent past its day is shown and treated as expired', async () => {
    const s = await setup();
    const id = await connect(s);
    // Renewal warning 14 days ahead (the fake session lasts to 14 January 2027).
    expect((await loadBankConnections(db, s.ctx.workspaceId, new Date('2027-01-05T00:00:00Z')))[0]).toMatchObject({ renewSoon: true, status: 'active' });
    s.setClock(new Date('2027-01-15T00:00:00Z'));
    expect((await loadBankConnections(db, s.ctx.workspaceId, new Date('2027-01-15T00:00:00Z')))[0].status).toBe('expired');
    expect(await syncConnection(db, s.ctx, s.deps, id, { today: '2027-01-15' })).toEqual({ status: 'expired', added: 0 });
    expect(s.bank.fetchCalls).toHaveLength(0);
  });
});

describe('bank connection: refusals and isolation', () => {
  it('an institution the interface does not offer, and a list-fed account, are refused before the bank is asked', async () => {
    const s = await setup();
    expect(await code(startConsent(db, s.ctx, s.deps, s.accountId, { name: 'Unbekannte Bank', country: 'DE' }))).toBe('aspsp_not_offered');
    expect(await code(startConsent(db, s.ctx, s.deps, s.accountId, { name: '', country: 'DE' }))).toBe('invalid_aspsp');
    const paypal = await createAccount(db, s.ctx, { label: 'Zahlungsdienst', kind: 'payment_service' });
    const header = 'Datum,Uhrzeit,Zeitzone,Name,Typ,Status,Währung,Brutto,Gebühr,Netto,Transaktionscode,Auswirkung auf Guthaben';
    await importPayments(db, s.ctx, paypal, `${header}\n01.09.2026,10:00:00,MESZ,Laden Beispiel,Zahlung,Abgeschlossen,EUR,"-10,00","0,00","-10,00",TX1,Soll\n`);
    expect(await code(startConsent(db, s.ctx, s.deps, paypal, BANK))).toBe('account_source_unsupported');
    expect(s.bank.starts).toHaveLength(0);
    expect(await db.taxBankConnection.count({ where: { authWorkspaceId: s.ctx.workspaceId } })).toBe(0);
  });

  it('a connection of another workspace can never be completed, synced, chosen or disconnected', async () => {
    const a = await setup();
    const b = await setup();
    await startConsent(db, a.ctx, a.deps, a.accountId, BANK);
    const state = a.bank.lastState;
    // B's session with A's state: refused, and A's consent stays usable.
    expect(await code(completeConsent(db, b.ctx.workspaceId, a.deps, { state, code: 'ok' }))).toBe('state_invalid');
    const { connectionId } = await completeConsent(db, a.ctx.workspaceId, a.deps, { state, code: 'ok' });
    expect(await code(syncConnection(db, b.ctx, b.deps, connectionId, { today: TODAY }))).toBe('connection_not_found');
    expect(await code(chooseBankAccount(db, b.ctx, connectionId, 'uid-a1'))).toBe('connection_not_found');
    expect(await code(disconnect(db, b.ctx, b.deps, connectionId))).toBe('connection_not_found');
    expect(await code(startConsent(db, b.ctx, b.deps, a.accountId, BANK))).toBe('account_not_found');
    expect(await loadBankConnections(db, b.ctx.workspaceId, NOW)).toEqual([]);
    expect(await connectionOf(a.accountId)).toMatchObject({ status: 'active' });
  });
});

beforeAll(() => {
  // Keep the output free of the deliberate failure logs of these tests.
  const original = console.error;
  console.error = (...args: unknown[]) => {
    if (typeof args[0] === 'string' && args[0].startsWith('[bank]')) return;
    original(...args);
  };
});
