import 'server-only';
import { createHash, randomBytes } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import { counterpartyKey, importPayments, PaymentServiceError, type PaymentContext } from '../service';
import { serviceOfInstitution } from '../funding';
import { parsePaymentFile, rateKey, toIsoDay, walletRateNeeds } from '../parse';
import { PaymentParseError, type NormalizedPayment } from '../types';
import { BankApiError, type BankApi, type BankErrorKind, type PsuPresence, type SessionAccount } from './client';

/**
 * The live bank connection of one account (finance plan, slice 3, Enable
 * Banking). Every function takes the workspace explicitly and addresses a
 * connection only inside it; the machine run (`syncAllConnections`) takes each
 * connection's own workspace from its row.
 *
 * The flow per account: pick the institution and start (`startConsent`, the
 * browser goes to the bank), the bank sends the person back to the callback
 * (`completeConsent`), one account of the session is bound (by itself when
 * there is one, or by `chooseBankAccount`), then `syncConnection` fetches the
 * booked movements and hands them to the normal import, so the bank is one
 * more source of the account next to its files: a day belongs to the source
 * that brought it first (see `coverage.ts`), and every movement is kept once.
 */

export type ConnectionStatus = 'pending' | 'choose_account' | 'active' | 'expired' | 'revoked' | 'error';

export type BankServiceErrorCode =
  | 'account_not_found'
  | 'connection_not_found'
  | 'invalid_aspsp'
  /** The interface does not offer this institution: the account stays on its file importer. */
  | 'aspsp_not_offered'
  /** The account is fed from the pay-later list (Klarna), whose purchases the bank interface does not offer. */
  | 'account_source_unsupported'
  /**
   * The institution does not fit what the account holds: a bank for an account
   * fed from PayPal, or PayPal for an account fed from a bank.
   */
  | 'institution_mismatch'
  /** The answer from the bank belongs to no consent in progress of this company (unknown, used, or another company's). */
  | 'state_invalid'
  | 'state_expired'
  | 'invalid_choice'
  /** A notice to clear that the connection does not hold, or one named wrongly. */
  | 'invalid_notice'
  | 'not_active'
  /** A call to the interface failed; `detail` is the kind. */
  | 'bank_error';

export class BankServiceError extends Error {
  readonly code: BankServiceErrorCode;
  readonly detail: string | null;
  constructor(code: BankServiceErrorCode, detail: string | null = null) {
    super(detail ? `${code}:${detail}` : code);
    this.name = 'BankServiceError';
    this.code = code;
    this.detail = detail;
  }
}

export interface BankDeps {
  api: BankApi;
  redirectUrl: string;
  now?: () => Date;
  /**
   * The reference rate (euro per unit) of a currency on a day, or null when it
   * cannot be had: for a wallet's movements in another currency. The server
   * uses the receipts' rate cache (`getFxRate`); without it such a movement
   * waits like one without a rate.
   */
  fxRate?: (currency: string, day: string) => Promise<number | null>;
}

/** How long the person has to come back from the bank. */
export const STATE_LIFETIME_MS = 30 * 60_000;
/** The longest consent asked for, whatever the institution allows. */
export const MAX_CONSENT_DAYS = 180;
/** The first fetch reaches this many days back: the payment services directive gives 90 days without a fresh confirmation at the bank. */
export const FIRST_FETCH_DAYS = 89;
/**
 * Each later fetch starts this many days before the last booked day, for movements the bank books late
 * (a card payment the bank dates back by a week or more). Overlapping days add nothing twice: a movement
 * already stored has the same identity, and one the bank reworded is recognized (`adoptReworded`).
 */
export const OVERLAP_DAYS = 12;
/** A warning is shown this many days before a consent runs out. */
export const RENEW_WARNING_DAYS = 14;

/** The pay-later list: its purchases are not offered by the interface (Klarna gives only its current account). */
const PAY_LATER_FORMATS = ['klarna_csv'];

/** The service an account's imports say it holds: 'paypal', 'klarna', 'bank' (a bank's file or live list), or null when it holds nothing. */
function accountSource(batches: ReadonlyArray<{ format: string; service: string | null }>): 'paypal' | 'klarna' | 'bank' | null {
  if (batches.some((b) => PAY_LATER_FORMATS.includes(b.format))) return 'klarna';
  if (batches.some((b) => b.format === 'paypal_csv' || b.service === 'paypal')) return 'paypal';
  return batches.length > 0 ? 'bank' : null;
}

const DAY_MS = 86_400_000;
const shiftDay = (day: string, by: number) => new Date(Date.parse(`${day}T00:00:00Z`) + by * DAY_MS).toISOString().slice(0, 10);
const hashState = (state: string) => createHash('sha256').update(state, 'utf8').digest('hex');

function bankError(e: unknown): never {
  if (e instanceof BankApiError) {
    if (e.kind === 'wrong_aspsp') throw new BankServiceError('aspsp_not_offered');
    throw new BankServiceError('bank_error', e.kind);
  }
  throw e;
}

async function ownConnection(db: PrismaClient | Prisma.TransactionClient, workspaceId: string, connectionId: string) {
  const connection = await db.taxBankConnection.findFirst({ where: { id: connectionId, authWorkspaceId: workspaceId } });
  if (!connection) throw new BankServiceError('connection_not_found');
  return connection;
}

/** The institutions the interface offers in a country, by name. */
export async function listInstitutions(deps: BankDeps, country = 'DE') {
  try {
    const list = await deps.api.listAspsps(country);
    return list.sort((a, b) => a.name.localeCompare(b.name, 'de'));
  } catch (e) {
    return bankError(e);
  }
}

/**
 * Start a consent for an account: a new connection, or the renewal of an
 * existing one (the account, its imports and its connection stay; the new
 * session replaces the old one when the bank's answer is taken). Returns the
 * address of the bank's own sign-in page.
 */
export async function startConsent(db: PrismaClient, ctx: PaymentContext, deps: BankDeps, accountId: string, raw: unknown): Promise<{ url: string }> {
  const input = (raw ?? {}) as { name?: unknown; country?: unknown };
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  const country = typeof input.country === 'string' ? input.country.trim().toUpperCase() : '';
  if (!name || name.length > 120 || !/^[A-Z]{2}$/.test(country)) throw new BankServiceError('invalid_aspsp');
  const account = await db.taxAccount.findFirst({ where: { id: accountId, authWorkspaceId: ctx.workspaceId }, include: { batches: { select: { format: true, service: true } } } });
  if (!account) throw new BankServiceError('account_not_found');
  // What the account holds decides which institution may continue it: PayPal's list only PayPal, a bank's
  // movements only a bank, the pay-later list nothing (plan 2026-10-23). An empty account takes any.
  const paypal = serviceOfInstitution(name) === 'paypal';
  const gate = (batches: ReadonlyArray<{ format: string; service: string | null }>) => {
    const holds = accountSource(batches);
    if (holds === 'klarna') throw new BankServiceError('account_source_unsupported');
    if ((holds === 'paypal' && !paypal) || (holds === 'bank' && paypal)) throw new BankServiceError('institution_mismatch');
  };
  // Before the bank is asked, and again under the account's lock when the connection is written.
  gate(account.batches);

  const now = (deps.now ?? (() => new Date()))();
  let institutions;
  try {
    institutions = await deps.api.listAspsps(country);
  } catch (e) {
    return bankError(e);
  }
  const institution = institutions.find((a) => a.name === name && a.country === country);
  if (!institution) throw new BankServiceError('aspsp_not_offered');
  const days = Math.min(MAX_CONSENT_DAYS, institution.maximumConsentValiditySeconds ? Math.floor(institution.maximumConsentValiditySeconds / 86_400) : MAX_CONSENT_DAYS);
  const validUntil = new Date(now.getTime() + Math.max(1, days) * DAY_MS);
  const state = randomBytes(32).toString('base64url');

  let url: string;
  try {
    ({ url } = await deps.api.startAuthorization({ aspsp: { name, country }, validUntil, state, redirectUrl: deps.redirectUrl }));
  } catch (e) {
    return bankError(e);
  }

  const consent = { stateHash: hashState(state), stateExpiresAt: new Date(now.getTime() + STATE_LIFETIME_MS), pendingAspspName: name, pendingAspspCountry: country };
  // Under the same lock an import and "Konto entfernen" take: an account removed or filled from another source
  // in the meantime is refused here, never written around. Two starts at the same moment queue on the lock, so
  // the second one finds the first one's connection and its consent is the one that counts.
  await db.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM tax_accounts WHERE id = ${accountId} AND auth_workspace_id = ${ctx.workspaceId} FOR UPDATE`;
    if (locked.length === 0) throw new BankServiceError('account_not_found');
    gate(await tx.taxImportBatch.findMany({ where: { accountId }, select: { format: true, service: true } }));
    const existing = await tx.taxBankConnection.findFirst({ where: { accountId, authWorkspaceId: ctx.workspaceId } });
    if (existing) {
      // A connection without a session yet takes the institution at once; one with a session keeps reading
      // through it until the new consent is taken (an abandoned renewal changes nothing).
      await tx.taxBankConnection.update({
        where: { id: existing.id },
        data: existing.sessionId ? consent : { ...consent, aspspName: name, aspspCountry: country, status: 'pending', lastError: null, lastErrorAt: null },
      });
    } else {
      await tx.taxBankConnection.create({
        data: { authWorkspaceId: ctx.workspaceId, authTenantId: ctx.tenantId, accountId, aspspName: name, aspspCountry: country, status: 'pending', ...consent },
      });
    }
  }, { maxWait: 20_000, timeout: 30_000 });
  return { url };
}

export type ConsentOutcome = 'connected' | 'choose_account';

/** The account of a renewed session that is the one read before, when exactly one is. */
function sameAccount(accounts: readonly SessionAccount[], bound: { boundMask: string | null; boundName: string | null }): SessionAccount | null {
  if (bound.boundMask === null && bound.boundName === null) return null;
  const hits = accounts.filter((a) => a.mask === bound.boundMask && a.name === (bound.boundName ?? ''));
  return hits.length === 1 ? hits[0] : null;
}

/**
 * Take the bank's answer (the callback). The state must belong to a consent
 * in progress of THIS workspace and be unexpired; it is used up before the
 * interface is asked, so a replayed answer is refused. An error from the bank
 * (the person cancelled) is recorded on the connection and nothing else changes.
 */
export async function completeConsent(
  db: PrismaClient,
  workspaceId: string,
  deps: BankDeps,
  params: { state?: string | null; code?: string | null; error?: string | null },
): Promise<{ connectionId: string; outcome: ConsentOutcome }> {
  const now = (deps.now ?? (() => new Date()))();
  if (!params.state || params.state.length > 200) throw new BankServiceError('state_invalid');
  const stateHash = hashState(params.state);
  const connection = await db.taxBankConnection.findFirst({ where: { stateHash, authWorkspaceId: workspaceId } });
  if (!connection) throw new BankServiceError('state_invalid');
  // Used up here, whatever follows: only one answer per consent is ever taken.
  const claimed = await db.taxBankConnection.updateMany({ where: { id: connection.id, stateHash }, data: { stateHash: null, stateExpiresAt: null } });
  if (claimed.count === 0) throw new BankServiceError('state_invalid');
  const fail = async (code: string) => {
    await db.taxBankConnection.update({
      where: { id: connection.id },
      data: { lastError: code, lastErrorAt: now, pendingAspspName: null, pendingAspspCountry: null, ...(connection.sessionId ? {} : { status: 'error' }) },
    });
  };
  if (!connection.stateExpiresAt || connection.stateExpiresAt.getTime() < now.getTime()) {
    await fail('consent_timed_out');
    throw new BankServiceError('state_expired');
  }
  if (params.error || !params.code) {
    await fail('consent_refused');
    throw new BankServiceError('bank_error', 'consent_refused');
  }
  let session;
  try {
    session = await deps.api.createSession(params.code);
  } catch (e) {
    await fail(e instanceof BankApiError ? e.kind : 'unknown');
    return bankError(e);
  }
  const accounts = session.accounts;
  if (accounts.length === 0) {
    await deps.api.deleteSession(session.sessionId).catch(() => undefined);
    await fail('no_accounts');
    throw new BankServiceError('bank_error', 'no_accounts');
  }
  const previous = { boundMask: connection.boundMask, boundName: connection.boundName };
  const boundBefore = previous.boundMask !== null || previous.boundName !== null;
  // A first consent with one account binds it. After a renewal only the same bank account binds by itself;
  // another one (another account, or another institution) is asked about, so it never flows into this account unseen.
  const pick = boundBefore ? sameAccount(accounts, previous) : accounts.length === 1 ? accounts[0] : null;
  // The same bank account as before keeps its last fetched day, so the next fetch continues; another starts afresh.
  // Only an account bound before can be the same one: a first binding always starts afresh and records when.
  const same = boundBefore && pick !== null && pick.mask === previous.boundMask && pick.name === (previous.boundName ?? '');
  const candidates = accounts.map((a) => ({ uid: a.uid, mask: a.mask, name: a.name, currency: a.currency }));
  await db.taxBankConnection.update({
    where: { id: connection.id },
    data: {
      sessionId: session.sessionId,
      validUntil: session.validUntil,
      aspspName: connection.pendingAspspName ?? connection.aspspName,
      aspspCountry: connection.pendingAspspCountry ?? connection.aspspCountry,
      pendingAspspName: null,
      pendingAspspCountry: null,
      candidates,
      lastError: null,
      lastErrorAt: null,
      ...(pick
        ? { status: 'active', accountUid: pick.uid, boundMask: pick.mask, boundName: pick.name, ...(same ? {} : { lastBookedThrough: null, fetchedThrough: null, boundAt: now, notices: Prisma.DbNull }) }
        : { status: 'choose_account', accountUid: null }),
    },
  });
  // The session this one replaces is closed at the bank; failing that it simply runs out.
  if (connection.sessionId && connection.sessionId !== session.sessionId) await deps.api.deleteSession(connection.sessionId).catch(() => undefined);
  return { connectionId: connection.id, outcome: pick ? 'connected' : 'choose_account' };
}

/** Bind one account of the session, or switch to another one of the same session. */
export async function chooseBankAccount(db: PrismaClient, ctx: PaymentContext, connectionId: string, uid: unknown, now: Date = new Date()): Promise<void> {
  const connection = await ownConnection(db, ctx.workspaceId, connectionId);
  const candidates = (Array.isArray(connection.candidates) ? connection.candidates : []) as Array<{ uid?: unknown; mask?: unknown; name?: unknown }>;
  const pick = candidates.find((c) => typeof uid === 'string' && c.uid === uid);
  if (!pick || !connection.sessionId) throw new BankServiceError('invalid_choice');
  const mask = typeof pick.mask === 'string' ? pick.mask : null;
  const name = typeof pick.name === 'string' ? pick.name : '';
  const boundBefore = connection.boundMask !== null || connection.boundName !== null;
  const same = boundBefore && mask === connection.boundMask && name === (connection.boundName ?? '');
  await db.taxBankConnection.update({
    where: { id: connection.id },
    data: { status: 'active', accountUid: pick.uid as string, boundMask: mask, boundName: name, lastError: null, lastErrorAt: null, ...(same ? {} : { lastBookedThrough: null, fetchedThrough: null, boundAt: now, notices: Prisma.DbNull }) },
  });
}

/**
 * End the connection: the session is closed at the bank and the connection is
 * removed. The payments it brought stay (they belong to their imports).
 * Returns whether the bank confirmed the end; when it could not be reached the
 * consent simply runs out on its day.
 */
export async function disconnect(db: PrismaClient, ctx: PaymentContext, deps: BankDeps, connectionId: string): Promise<{ closedAtBank: boolean }> {
  const connection = await ownConnection(db, ctx.workspaceId, connectionId);
  let closedAtBank = true;
  if (connection.sessionId) {
    try {
      await deps.api.deleteSession(connection.sessionId);
    } catch (e) {
      // A session the bank already ended is ended.
      closedAtBank = e instanceof BankApiError && (e.kind === 'session_expired' || e.kind === 'session_revoked');
      if (!closedAtBank) console.warn(`[bank] closing a session at the bank failed (${e instanceof BankApiError ? e.kind : 'error'})`);
    }
  }
  await db.taxBankConnection.deleteMany({ where: { id: connection.id, authWorkspaceId: ctx.workspaceId } });
  return { closedAtBank };
}

/**
 * Take a signed daily-run call's time as the last accepted one, only when it
 * is later than the stored one. One statement, so two app instances (or two
 * deliveries at the same moment) can never both take the same call.
 */
export async function claimDailySync(db: PrismaClient, ts: number): Promise<boolean> {
  const rows = await db.$queryRaw<Array<{ last_ts: bigint }>>`
    INSERT INTO tax_bank_sync_guard (id, last_ts) VALUES ('daily', ${ts})
    ON CONFLICT (id) DO UPDATE SET last_ts = EXCLUDED.last_ts WHERE tax_bank_sync_guard.last_ts < EXCLUDED.last_ts
    RETURNING last_ts`;
  return rows.length === 1;
}

/**
 * End every bank connection of an erased company (auth-brain's `tenant.erased`):
 * each session is closed at the bank where that works, and every connection
 * of the company and of the workspaces it names is removed, so the daily run
 * reads nothing of it any more. The payments already fetched are the
 * company's records like any other. Repeat-safe. Returns how many were removed.
 */
export async function endCompanyBankConnections(db: PrismaClient, deps: BankDeps | null, tenantId: string, workspaceIds: readonly string[]): Promise<number> {
  const where = { OR: [{ authTenantId: tenantId }, ...(workspaceIds.length > 0 ? [{ authWorkspaceId: { in: [...workspaceIds] } }] : [])] };
  const connections = await db.taxBankConnection.findMany({ where, select: { id: true, sessionId: true } });
  for (const c of connections) {
    if (!c.sessionId || !deps) continue;
    try {
      await deps.api.deleteSession(c.sessionId);
    } catch (e) {
      // The connection goes all the same; a session the bank keeps runs out by itself.
      console.warn(`[bank] closing a session of an erased company failed (${e instanceof BankApiError ? e.kind : 'error'})`);
    }
  }
  const { count } = await db.taxBankConnection.deleteMany({ where: { id: { in: connections.map((c) => c.id) } } });
  return count;
}

export type SyncStatus =
  | 'synced'
  | 'nothing_new'
  | 'expired'
  | 'revoked'
  | 'rate_limited'
  | 'failed'
  | 'not_active'
  /** Not started in this run because its time ran short; the next run fetches it (from where it stopped, nothing is lost). */
  | 'deferred';

/**
 * The time the fetches of a daily run may take, so the run answers inside the
 * scheduler's 280 seconds and the route's 300. No new connection starts after
 * `RUN_BUDGET_MS`; no call to the bank runs past `RUN_DEADLINE_MS` (a call is
 * cut there); an import already running ends within its transaction's 120
 * seconds (after at most 20 waiting for a database connection). 100 + 140 =
 * 240. What is left is `deferred` and fetched by the next run. The spending
 * checks run after the answer (see `runSpendingChecksForLiveCompanies`).
 */
export const RUN_BUDGET_MS = 60_000;
export const RUN_DEADLINE_MS = 100_000;

export interface SyncOutcome {
  status: SyncStatus;
  /** Payments the fetch added. */
  added: number;
  /** For `failed`: what went wrong, as a code. */
  error?: string;
}

/** Movements of one fetch left out as unreadable at most; beyond that the fetch fails as a whole. */
export const MAX_UNREADABLE = 20;

/** Import results that mean "nothing new" for a fetch of overlapping days. */
const NOTHING_NEW = new Set(['nothing_new', 'file_already_imported', 'nothing_uncovered']);

/**
 * Fetch the booked movements of an active connection and import them. The
 * first fetch reaches back 89 days, every later one starts twelve days before
 * the last booked day it saw. A fetch that adds nothing leaves no import
 * behind. An ended session marks the connection expired or revoked and keeps
 * everything; a rate limit keeps it active for the next run; any other
 * failure is recorded on the connection and shown.
 */
export async function syncConnection(
  db: PrismaClient,
  ctx: PaymentContext,
  deps: BankDeps,
  connectionId: string,
  options: {
    today: string;
    /** Set when the person is present ("Jetzt abholen"), so the bank does not count the call as unattended. */
    psu?: PsuPresence;
    /** The time (epoch milliseconds) after which no further page is fetched; the rest waits for the next run. */
    deadline?: number;
  },
): Promise<SyncOutcome> {
  const now = (deps.now ?? (() => new Date()))();
  const connection = await ownConnection(db, ctx.workspaceId, connectionId);
  if (connection.status !== 'active' || !connection.sessionId || !connection.accountUid) return { status: 'not_active', added: 0 };
  if (connection.validUntil && connection.validUntil.getTime() <= now.getTime()) {
    await db.taxBankConnection.updateMany({ where: { id: connection.id, sessionId: connection.sessionId }, data: { status: 'expired' } });
    return { status: 'expired', added: 0 };
  }
  // Written only while the connection still reads the same session and account: a renewal or another choice
  // in the meantime has reset what it needed, and this run's view of it is stale.
  const record = (data: Prisma.TaxBankConnectionUpdateManyMutationInput) =>
    db.taxBankConnection.updateMany({ where: { id: connection.id, sessionId: connection.sessionId, accountUid: connection.accountUid }, data });
  // Every attempt counts for the order of the daily run, whatever comes of it: a bank failing or slow every
  // day goes to the back, so it never keeps the other connections waiting.
  await record({ lastAttemptedAt: now });
  // Never further back than the 90 days the bank gives without a fresh confirmation: a quiet account
  // whose last booking is older would otherwise be refused on every run. Days before that are left to a file import,
  // and when a renewal came so late that days in between can no longer be fetched, the connection keeps them as a gap.
  const earliest = shiftDay(options.today, -FIRST_FETCH_DAYS);
  const continued = connection.lastBookedThrough ? shiftDay(connection.lastBookedThrough, -OVERLAP_DAYS) : earliest;
  const dateFrom = continued < earliest ? earliest : continued > options.today ? options.today : continued;
  // A gap is what lies between the last day a fetch reached and the oldest day the bank still gives: only
  // after a pause longer than that (a consent renewed late). A quiet account with old bookings has none.
  const found: BankNotices = { gaps: [], skipped: [], undated: [], unrated: [], dismissed: { skipped: [], undated: [], unrated: [] } };
  if (connection.fetchedThrough && shiftDay(connection.fetchedThrough, 1) < earliest) {
    found.gaps.push({ from: shiftDay(connection.fetchedThrough, 1), to: shiftDay(earliest, -1) });
  }

  let transactions: unknown[];
  try {
    transactions = await deps.api.fetchTransactions(connection.accountUid, dateFrom, options.today, options.psu, options.deadline !== undefined ? { deadline: options.deadline } : undefined);
  } catch (e) {
    const kind: BankErrorKind | 'unknown' = e instanceof BankApiError ? e.kind : 'unknown';
    if (!(e instanceof BankApiError)) console.error('[bank] fetch failed', (e as Error)?.name ?? 'error');
    // The run's time ran out between two pages: nothing is lost, the next run fetches the same days.
    if (kind === 'deadline') return { status: 'deferred', added: 0 };
    if (kind === 'session_expired' || kind === 'session_revoked') {
      const status = kind === 'session_expired' ? 'expired' : 'revoked';
      await record({ status, lastError: kind, lastErrorAt: now });
      return { status, added: 0 };
    }
    await record({ lastError: kind, lastErrorAt: now });
    return kind === 'rate_limited' ? { status: 'rate_limited', added: 0 } : { status: 'failed', added: 0, error: kind };
  }

  // A payment service's wallet read through the interface (PayPal, plan 2026-10-23): its movements in another
  // currency are imported at the reference rate of their day, so the rates are looked up first and the reader
  // stays pure. A movement whose rate cannot be had waits: its day is kept as a notice, and the next fetch
  // starts before it.
  const service = serviceOfInstitution(connection.aspspName);
  const rates = new Map<string, number>();
  const unrated = new Set<string>();
  if (service !== null) {
    // All at once: each lookup may wait for the rate service, and a fetch never waits for them one by one.
    const needs = walletRateNeeds(transactions.filter((t) => !((movementDay(t) ?? '') > options.today)));
    const looked = await Promise.all(
      needs.map(async (need) => {
        try {
          return deps.fxRate ? await deps.fxRate(need.currency, need.day) : null;
        } catch {
          return null;
        }
      }),
    );
    for (const [i, need] of needs.entries()) {
      const rate = looked[i];
      if (rate !== null && Number.isFinite(rate) && rate > 0) rates.set(rateKey(need.currency, need.day), rate);
      else unrated.add(need.day);
    }
  }
  const parseOptions = service !== null ? { wallet: { rates } } : undefined;

  const bookedDays = transactions.flatMap((t) => ((t as { status?: unknown })?.status === 'BOOK' && movementDay(t) ? [movementDay(t) as string] : []));
  let added = 0;
  // A booking dated after today is left for a later fetch: imported now, it would make this import claim the
  // days up to that date, and a file import of those days would then leave its movements out as covered.
  // The day is the one the import reads (booking day, else transaction day, else value day).
  let rows = transactions.filter((t) => !((movementDay(t) ?? '') > options.today));
  // A movement the bank describes incompletely would reject the whole fetch on every run; it is left out and
  // counted instead (at most MAX_UNREADABLE). Its day is kept as a notice until the person clears it, and the
  // next fetch starts before it, so a movement the bank completes later still arrives.
  const skippedDays = new Set<string>();
  const undatedSeen = new Map<string, number>();
  let unreadable = 0;
  while (rows.length > 0) {
    try {
      const parsed = parsePaymentFile(JSON.stringify({ transactions: rows }), parseOptions);
      await adoptReworded(db, connection.accountId, parsed.payments, { from: dateFrom, to: options.today, except: new Set([...skippedDays, ...unrated]), since: connection.boundAt });
      // The days this fetch leaves a movement out of go on the import, so a file can still bring that movement.
      const result = await importPayments(db, ctx, connection.accountId, JSON.stringify({ transactions: rows }), { refuseEmpty: true, parse: parseOptions, service, partialDays: [...skippedDays, ...unrated] });
      added = result.added;
      break;
    } catch (e) {
      if (e instanceof PaymentParseError && e.code === 'unreadable_row' && e.row !== null && unreadable < MAX_UNREADABLE) {
        const day = movementDay(rows[e.row - 1]);
        // A movement without any readable day cannot be kept as a day; it is counted, so it is not lost in silence.
        if (day) skippedDays.add(day);
        else found.undated.push(undatedKey(rows[e.row - 1], undatedSeen));
        rows = rows.filter((_, index) => index !== e.row! - 1);
        unreadable++;
        continue;
      }
      const nothingNew = (e instanceof PaymentServiceError && NOTHING_NEW.has(e.code)) || (e instanceof PaymentParseError && e.code === 'empty');
      if (nothingNew) break;
      const code = e instanceof PaymentServiceError ? e.code : e instanceof PaymentParseError ? `parse_${e.code}` : 'import_failed';
      if (code === 'import_failed') console.error('[bank] import of fetched movements failed', (e as Error)?.name ?? 'error');
      await record({ lastError: code, lastErrorAt: now });
      return { status: 'failed', added: 0, error: code };
    }
  }
  // A skipped day stays until the person clears it (after checking it against a statement or a file import),
  // also when a later fetch brings that movement complete: only he knows whether the day is now in order.
  found.skipped = [...skippedDays].sort();
  found.unrated = [...unrated].sort();
  // A booking dated after today (a card's future booking day) never moves the start of the next fetch past today,
  // and a day with a skipped movement keeps the next fetch reaching back to it.
  let latest = [connection.lastBookedThrough, ...bookedDays.filter((d) => d <= options.today)].filter((d): d is string => !!d).sort().pop() ?? null;
  // A day the person cleared no longer holds the next fetch back, even while the bank keeps listing it broken.
  const held = bankNotices(connection.notices).dismissed;
  const cleared = new Set(held.skipped);
  const clearedUnrated = new Set(held.unrated);
  // A day with a movement still waiting for its rate holds the next fetch back the same way, until he clears it.
  const firstSkipped = [found.skipped.find((d) => !cleared.has(d)), found.unrated.find((d) => !clearedUnrated.has(d))].filter((d): d is string => !!d).sort()[0];
  if (latest && firstSkipped && shiftDay(firstSkipped, OVERLAP_DAYS - 1) < latest) latest = shiftDay(firstSkipped, OVERLAP_DAYS - 1);
  // One write under the row's lock, and only while the connection still reads the same session and account: a
  // switch in the meantime has started that account afresh, and nothing of this fetch belongs to it.
  await db.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{ notices: Prisma.JsonValue | null; session_id: string | null; account_uid: string | null }>>`
      SELECT notices, session_id, account_uid FROM tax_bank_connections WHERE id = ${connection.id} FOR UPDATE`;
    if (rows.length === 0 || rows[0].session_id !== connection.sessionId || rows[0].account_uid !== connection.accountUid) return;
    await tx.taxBankConnection.update({
      where: { id: connection.id },
      data: {
        lastSyncedAt: now,
        lastBookedThrough: latest,
        fetchedThrough: options.today,
        lastError: null,
        lastErrorAt: null,
        notices: mergeNotices(bankNotices(rows[0].notices), found, earliest, dateFrom) as unknown as Prisma.InputJsonValue,
      },
    });
  }, { maxWait: 10_000, timeout: 20_000 });
  return { status: added > 0 ? 'synced' : 'nothing_new', added };
}

/** The day of a fetched movement as the import reads it: booking day, else transaction day, else value day. */
function movementDay(raw: unknown): string | null {
  // Exactly as the reader of the bank interface's list takes it (`parseEnableBanking`), so both agree on every row.
  const t = (raw ?? {}) as { booking_date?: string; transaction_date?: string; value_date?: string };
  return toIsoDay(t.booking_date ?? t.transaction_date ?? t.value_date);
}

/**
 * What a connection keeps for the person to look at until he clears it:
 * `gaps`, days no fetch can reach any more (after a pause longer than the 89
 * days the bank looks back; a file import fills them), `skipped`, days with a
 * movement the bank described too incompletely to import, and `undated`, one
 * key per such movement that had no readable day at all (a booking listed on
 * every fetch is still one booking). `dismissed` holds what the person
 * cleared, so a fetch that sees the same broken booking again does not bring
 * the notice back. `unrated`: days with a movement in another currency whose
 * reference rate could not be had; unlike the others it is what the last
 * fetch found (a day goes by itself once its movement arrived), and a day
 * older than the window a fetch still reaches stays until the person clears it.
 * A cleared one stays cleared (a currency the rate service never knows): the
 * PayPal list brings that movement with its real euro amount, because the
 * import kept the day as one it holds in part (`partialDays`).
 */
export interface BankNotices {
  gaps: Array<{ from: string; to: string }>;
  skipped: string[];
  undated: string[];
  unrated: string[];
  dismissed: { skipped: string[]; undated: string[]; unrated: string[] };
}

/** At most this many cleared undated keys are remembered; older ones are long out of every fetch window. */
const DISMISSED_UNDATED_LIMIT = 200;

/** Text of a value with its keys in sorted order, so a bank that lists the same fields in another order gives the same text. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>).sort().map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * One stable key per undated booking: its own reference where the bank gives
 * one, else its content, numbered by how often the same content occurs in one
 * fetch (two identical charges are two bookings). Never bank data itself.
 */
function undatedKey(raw: unknown, seen: Map<string, number>): string {
  const ref = (raw as { entry_reference?: unknown })?.entry_reference;
  const basis = typeof ref === 'string' && ref ? `ref:${ref}` : `row:${canonical(raw)}`;
  const occurrence = (seen.get(basis) ?? 0) + 1;
  seen.set(basis, occurrence);
  return createHash('sha256').update(`${basis}|${occurrence}`).digest('hex').slice(0, 24);
}

export function bankNotices(value: Prisma.JsonValue | null | undefined): BankNotices {
  const v = (value ?? {}) as { gaps?: unknown; skipped?: unknown; undated?: unknown; unrated?: unknown; dismissed?: { skipped?: unknown; undated?: unknown; unrated?: unknown } };
  const isDay = (d: unknown): d is string => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d);
  const isKey = (k: unknown): k is string => typeof k === 'string' && /^[0-9a-f]{24}$/.test(k);
  const list = <T>(x: unknown, ok: (y: unknown) => y is T): T[] => (Array.isArray(x) ? x.filter(ok) : []);
  return {
    gaps: list(v.gaps, (g): g is { from: string; to: string } => isDay((g as { from?: unknown })?.from) && isDay((g as { to?: unknown })?.to)),
    skipped: list(v.skipped, isDay),
    undated: list(v.undated, isKey),
    unrated: list(v.unrated, isDay),
    dismissed: { skipped: list(v.dismissed?.skipped, isDay), undated: list(v.dismissed?.undated, isKey), unrated: list(v.dismissed?.unrated, isDay) },
  };
}

/**
 * What a fetch found, added to what the connection holds: nothing held is
 * dropped, and nothing the person cleared comes back. Cleared days older than
 * the oldest day the bank still gives can never be fetched again and are forgotten.
 */
function mergeNotices(current: BankNotices, found: BankNotices, oldestDay: string, fetchedFrom: string): BankNotices {
  const gaps = [...current.gaps];
  for (const g of found.gaps) if (!gaps.some((x) => x.from === g.from && x.to === g.to)) gaps.push(g);
  const dismissedSkipped = new Set(current.dismissed.skipped);
  const dismissedUndated = new Set(current.dismissed.undated);
  const dismissedUnrated = new Set(current.dismissed.unrated);
  return {
    gaps,
    skipped: [...new Set([...current.skipped, ...found.skipped.filter((d) => !dismissedSkipped.has(d))])].sort(),
    undated: [...new Set([...current.undated, ...found.undated.filter((k) => !dismissedUndated.has(k))])],
    // What this fetch saw replaces what it covered; a day before its window is out of reach and stays.
    unrated: [...new Set([...current.unrated.filter((d) => d < fetchedFrom), ...found.unrated.filter((d) => !dismissedUnrated.has(d))])].sort(),
    dismissed: {
      skipped: current.dismissed.skipped.filter((d) => d >= oldestDay),
      undated: current.dismissed.undated.slice(-DISMISSED_UNDATED_LIMIT),
      unrated: current.dismissed.unrated.filter((d) => d >= oldestDay),
    },
  };
}

/** What the screen shows of a connection's notices. */
export interface BankNoticesView {
  gaps: Array<{ from: string; to: string }>;
  skipped: string[];
  /** Days with a movement in another currency still waiting for its reference rate. */
  unrated: string[];
  /** The keys of the bookings without a day; the screen shows how many and sends them back to clear exactly those. */
  undated: string[];
}

/**
 * Change a connection's notices under a row lock: a fetch adds and a person
 * clears at the same moment, and neither may undo the other.
 */
async function changeNotices(db: PrismaClient, connectionId: string, change: (current: BankNotices) => BankNotices, workspaceId: string): Promise<boolean> {
  return db.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{ notices: Prisma.JsonValue | null; auth_workspace_id: string }>>`
      SELECT notices, auth_workspace_id FROM tax_bank_connections WHERE id = ${connectionId} FOR UPDATE`;
    if (rows.length === 0 || rows[0].auth_workspace_id !== workspaceId) return false;
    const next = change(bankNotices(rows[0].notices));
    await tx.taxBankConnection.update({ where: { id: connectionId }, data: { notices: next as unknown as Prisma.InputJsonValue } });
    return true;
  });
}

/**
 * The person has looked at a notice (filled the gap, checked the day, checked
 * the bookings without a day): exactly what he saw goes, and a later fetch
 * does not bring it back. A booking without a day added after he looked stays.
 */
export async function clearBankNotice(db: PrismaClient, ctx: PaymentContext, connectionId: string, raw: unknown): Promise<void> {
  const input = (raw ?? {}) as { kind?: unknown; day?: unknown; from?: unknown; to?: unknown; keys?: unknown };
  const connection = await ownConnection(db, ctx.workspaceId, connectionId);
  let change: (current: BankNotices) => BankNotices;
  if (input.kind === 'skipped' && typeof input.day === 'string') {
    const day = input.day;
    // Only a day that is shown is remembered as cleared: a day sent by mistake never hides a later notice.
    change = (c) => (c.skipped.includes(day) ? { ...c, skipped: c.skipped.filter((d) => d !== day), dismissed: { ...c.dismissed, skipped: [...new Set([...c.dismissed.skipped, day])] } } : c);
  } else if (input.kind === 'unrated' && typeof input.day === 'string') {
    const day = input.day;
    // Like a skipped day: only a day that is shown is remembered as cleared.
    change = (c) => (c.unrated.includes(day) ? { ...c, unrated: c.unrated.filter((d) => d !== day), dismissed: { ...c.dismissed, unrated: [...new Set([...c.dismissed.unrated, day])] } } : c);
  } else if (input.kind === 'gap' && typeof input.from === 'string' && typeof input.to === 'string') {
    change = (c) => ({ ...c, gaps: c.gaps.filter((g) => g.from !== input.from || g.to !== input.to) });
  } else if (input.kind === 'undated' && Array.isArray(input.keys) && input.keys.every((k) => typeof k === 'string')) {
    const seen = new Set(input.keys as string[]);
    change = (c) => ({ ...c, undated: c.undated.filter((k) => !seen.has(k)), dismissed: { ...c.dismissed, undated: [...new Set([...c.dismissed.undated, ...c.undated.filter((k) => seen.has(k))])] } });
  } else throw new BankServiceError('invalid_notice');
  if (!(await changeNotices(db, connection.id, change, ctx.workspaceId))) throw new BankServiceError('connection_not_found');
}

/**
 * A bank may reword a booking between two fetches (another text, a fuller
 * name). Its identity is built from those words, so it would be stored a
 * second time. Within the days this fetch covers completely, a stored movement
 * of the bank interface that the bank no longer lists and a fetched one that is
 * not stored, alone on the same day with the same amount, are the same booking:
 * the stored one takes the new identity and words and keeps its links. Days
 * with a skipped movement are left alone, because their list is incomplete.
 */
async function adoptReworded(
  db: PrismaClient,
  accountId: string,
  fetched: readonly NormalizedPayment[],
  window: { from: string; to: string; except: ReadonlySet<string>; since: Date | null },
): Promise<number> {
  const inWindow = fetched.filter((p) => p.bookingDay >= window.from && p.bookingDay <= window.to && !window.except.has(p.bookingDay));
  if (inWindow.length === 0) return 0;
  const stored = await db.taxPayment.findMany({
    // Only what this connection brought from the bank account it reads now: after a switch to another account
    // of the session, the payments of the one read before are not this account's bookings.
    where: { accountId, bookingDay: { gte: window.from, lte: window.to }, cancelledByBatchId: null, batch: { format: 'enable_banking_json', ...(window.since ? { createdAt: { gte: window.since } } : {}) } },
    select: { id: true, sourceHash: true, bookingDay: true, amountCents: true },
  });
  const fetchedHashes = new Set(fetched.map((p) => p.sourceHash));
  // Any payment of the account holding a fetched identity (a file import's too) means that booking is stored.
  const storedHashes = new Set(
    (await db.taxPayment.findMany({ where: { accountId, sourceHash: { in: inWindow.map((p) => p.sourceHash) } }, select: { sourceHash: true } })).map((p) => p.sourceHash),
  );
  for (const p of stored) storedHashes.add(p.sourceHash);
  const key = (p: { bookingDay: string; amountCents: number }) => `${p.bookingDay}|${p.amountCents}`;
  const group = <T extends { bookingDay: string; amountCents: number }>(list: readonly T[]) => {
    const out = new Map<string, T[]>();
    for (const p of list) out.set(key(p), [...(out.get(key(p)) ?? []), p]);
    return out;
  };
  const vanished = group(stored.filter((p) => !fetchedHashes.has(p.sourceHash) && !window.except.has(p.bookingDay)));
  const fresh = group(inWindow.filter((p) => !storedHashes.has(p.sourceHash)));
  let adopted = 0;
  for (const [k, olds] of vanished) {
    const news = fresh.get(k);
    if (olds.length !== 1 || !news || news.length !== 1) continue;
    const p = news[0];
    await db.taxPayment.update({
      where: { id: olds[0].id },
      data: {
        sourceHash: p.sourceHash,
        counterparty: p.counterparty,
        counterpartyKey: counterpartyKey(p.counterparty),
        reference: p.reference,
        entryReference: p.entryReference,
        originalAmountCents: p.original?.amountCents ?? null,
        originalCurrency: p.original?.currency ?? null,
        amountEstimated: p.estimated === true,
      },
    });
    adopted++;
  }
  return adopted;
}

export interface SyncRunEntry {
  connectionId: string;
  /** The company of the connection, so the spending checks after the run know whom to check. Not in the answer. */
  workspaceId: string;
  tenantId: string | null;
  status: SyncStatus;
  added: number;
}

/**
 * The order of a daily run: the connection tried longest ago first (never
 * tried before everything), then the older connection. A bank that fails or is
 * slow every day thereby goes to the back, and keeps no other one waiting.
 */
export function runOrder<T extends { id: string; lastAttemptedAt: Date | null; createdAt: Date }>(connections: readonly T[]): T[] {
  const time = (d: Date | null) => (d === null ? -Infinity : d.getTime());
  return [...connections].sort((a, b) => time(a.lastAttemptedAt) - time(b.lastAttemptedAt) || a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : 1));
}

/**
 * The daily run: every active connection of every workspace, one after the
 * other (each import locks its account, and banks limit calls), each on its
 * own so one failing bank never stops the others. Consents that ran out are
 * marked expired. After `RUN_BUDGET_MS` no further connection is started, and
 * every call to the bank is cut at `RUN_DEADLINE_MS` (real time, which is what
 * the bank client compares with); those are reported as `deferred` and fetched
 * by the next run. `clock` only decides when to stop starting (tests).
 */
export async function syncAllConnections(
  db: PrismaClient,
  deps: BankDeps,
  options: { today: string; budgetMs?: number; clock?: () => number },
): Promise<SyncRunEntry[]> {
  const clock = options.clock ?? (() => Date.now());
  const startedAt = clock();
  const budget = options.budgetMs ?? RUN_BUDGET_MS;
  const deadline = Date.now() + RUN_DEADLINE_MS;
  const connections = runOrder(
    await db.taxBankConnection.findMany({ where: { status: 'active' }, select: { id: true, authWorkspaceId: true, authTenantId: true, lastAttemptedAt: true, createdAt: true } }),
  );
  const out: SyncRunEntry[] = [];
  for (const c of connections) {
    const base = { connectionId: c.id, workspaceId: c.authWorkspaceId, tenantId: c.authTenantId };
    if (clock() - startedAt >= budget) {
      out.push({ ...base, status: 'deferred', added: 0 });
      continue;
    }
    try {
      const result = await syncConnection(db, { workspaceId: c.authWorkspaceId, tenantId: c.authTenantId }, deps, c.id, { today: options.today, deadline });
      out.push({ ...base, status: result.status, added: result.added });
    } catch (e) {
      console.error('[bank] sync of a connection failed', (e as Error)?.name ?? 'error');
      out.push({ ...base, status: 'failed', added: 0 });
    }
  }
  return out;
}

/**
 * The spending checks (missing receipts, budgets) for every company with a
 * live connection, those that got new payments first, one after the other.
 * Run after the daily run has answered, so they never count against the
 * scheduler's time. They are idempotent and bounded; a failure is logged and
 * stops none of the others.
 */
export async function runSpendingChecksForLiveCompanies(results: readonly SyncRunEntry[], check: (ctx: PaymentContext) => Promise<unknown>): Promise<void> {
  const order = [...results].sort((a, b) => (b.added > 0 ? 1 : 0) - (a.added > 0 ? 1 : 0));
  const done = new Set<string>();
  for (const r of order) {
    if (done.has(r.workspaceId)) continue;
    done.add(r.workspaceId);
    try {
      await check({ workspaceId: r.workspaceId, tenantId: r.tenantId });
    } catch (e) {
      console.error('[bank] spending checks after the bank fetch failed', (e as Error)?.name ?? 'error');
    }
  }
}

// ── Reading ──────────────────────────────────────────────────────────────────

export interface BankConnectionView {
  id: string;
  accountId: string;
  /** As stored, except that an active consent past its day reads `expired`. */
  status: ConnectionStatus;
  aspspName: string;
  /** The institution a consent in progress asks, when it differs from the current one. */
  pendingAspspName: string | null;
  validUntil: string | null;
  /** True when the consent runs out within 14 days. */
  renewSoon: boolean;
  lastSyncedAt: string | null;
  lastBookedThrough: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  /** What the person has to look at until he clears it (see `BankNotices`). */
  notices: BankNoticesView;
  /** The masked accounts of the session to choose from (also after a choice, to switch). */
  candidates: Array<{ uid: string; mask: string | null; name: string; currency: string | null }>;
  /** The uid of the bound account of the session. */
  accountUid: string | null;
  /** The masked number and name of the bank account read before (a renewal asks when the new session lacks it). */
  boundMask: string | null;
  boundName: string | null;
}

export async function loadBankConnections(db: PrismaClient, workspaceId: string, now: Date = new Date()): Promise<BankConnectionView[]> {
  const rows = await db.taxBankConnection.findMany({ where: { authWorkspaceId: workspaceId } });
  return rows.map((r) => {
    const past = r.validUntil !== null && r.validUntil.getTime() <= now.getTime();
    const candidates = (Array.isArray(r.candidates) ? r.candidates : []) as Array<{ uid?: unknown; mask?: unknown; name?: unknown; currency?: unknown }>;
    return {
      id: r.id,
      accountId: r.accountId,
      status: (r.status === 'active' && past ? 'expired' : r.status) as ConnectionStatus,
      aspspName: r.aspspName,
      pendingAspspName: r.pendingAspspName && r.pendingAspspName !== r.aspspName ? r.pendingAspspName : null,
      validUntil: r.validUntil?.toISOString() ?? null,
      renewSoon: r.validUntil !== null && !past && r.validUntil.getTime() - now.getTime() <= RENEW_WARNING_DAYS * DAY_MS,
      lastSyncedAt: r.lastSyncedAt?.toISOString() ?? null,
      lastBookedThrough: r.lastBookedThrough,
      lastError: r.lastError,
      lastErrorAt: r.lastErrorAt?.toISOString() ?? null,
      notices: (({ gaps, skipped, undated, unrated }) => ({ gaps, skipped, undated, unrated }))(bankNotices(r.notices)),
      candidates: candidates.flatMap((c) =>
        typeof c.uid === 'string' ? [{ uid: c.uid, mask: typeof c.mask === 'string' ? c.mask : null, name: typeof c.name === 'string' ? c.name : '', currency: typeof c.currency === 'string' ? c.currency : null }] : [],
      ),
      accountUid: r.accountUid,
      boundMask: r.boundMask,
      boundName: r.boundName,
    };
  });
}
