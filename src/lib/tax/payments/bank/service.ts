import 'server-only';
import { createHash, randomBytes } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import { importPayments, PaymentServiceError, type PaymentContext } from '../service';
import { PaymentParseError } from '../types';
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
  /** The account is fed from a payment service's or pay-later list, which the bank interface cannot continue. */
  | 'account_source_unsupported'
  /** The answer from the bank belongs to no consent in progress of this company (unknown, used, or another company's). */
  | 'state_invalid'
  | 'state_expired'
  | 'invalid_choice'
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
}

/** How long the person has to come back from the bank. */
export const STATE_LIFETIME_MS = 30 * 60_000;
/** The longest consent asked for, whatever the institution allows. */
export const MAX_CONSENT_DAYS = 180;
/** The first fetch reaches this many days back: the payment services directive gives 90 days without a fresh confirmation at the bank. */
export const FIRST_FETCH_DAYS = 89;
/** Each later fetch starts this many days before the last booked day, for movements the bank books late. */
export const OVERLAP_DAYS = 5;
/** A warning is shown this many days before a consent runs out. */
export const RENEW_WARNING_DAYS = 14;

/** Formats of a payment service's or pay-later list: a bank source cannot continue them (see `BANK_FORMATS` in the payments service). */
const LIST_FORMATS = ['paypal_csv', 'klarna_csv'];

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
  const account = await db.taxAccount.findFirst({ where: { id: accountId, authWorkspaceId: ctx.workspaceId }, include: { batches: { select: { format: true } } } });
  if (!account) throw new BankServiceError('account_not_found');
  if (account.batches.some((b) => LIST_FORMATS.includes(b.format))) throw new BankServiceError('account_source_unsupported');

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
  const existing = await db.taxBankConnection.findFirst({ where: { accountId, authWorkspaceId: ctx.workspaceId } });
  if (existing) {
    // A connection without a session yet takes the institution at once; one with a session keeps reading
    // through it until the new consent is taken (an abandoned renewal changes nothing).
    await db.taxBankConnection.update({
      where: { id: existing.id },
      data: existing.sessionId ? consent : { ...consent, aspspName: name, aspspCountry: country, status: 'pending', lastError: null, lastErrorAt: null },
    });
  } else {
    try {
      await db.taxBankConnection.create({
        data: { authWorkspaceId: ctx.workspaceId, authTenantId: ctx.tenantId, accountId, aspspName: name, aspspCountry: country, status: 'pending', ...consent },
      });
    } catch (e) {
      // Two starts at the same moment: the other one created the connection; this consent is the one that counts now.
      if ((e as { code?: string })?.code !== 'P2002') throw e;
      await db.taxBankConnection.updateMany({ where: { accountId, authWorkspaceId: ctx.workspaceId }, data: consent });
    }
  }
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
  const same = pick !== null && pick.mask === previous.boundMask && pick.name === (previous.boundName ?? '');
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
        ? { status: 'active', accountUid: pick.uid, boundMask: pick.mask, boundName: pick.name, ...(same ? {} : { lastBookedThrough: null }) }
        : { status: 'choose_account', accountUid: null }),
    },
  });
  // The session this one replaces is closed at the bank; failing that it simply runs out.
  if (connection.sessionId && connection.sessionId !== session.sessionId) await deps.api.deleteSession(connection.sessionId).catch(() => undefined);
  return { connectionId: connection.id, outcome: pick ? 'connected' : 'choose_account' };
}

/** Bind one account of the session, or switch to another one of the same session. */
export async function chooseBankAccount(db: PrismaClient, ctx: PaymentContext, connectionId: string, uid: unknown): Promise<void> {
  const connection = await ownConnection(db, ctx.workspaceId, connectionId);
  const candidates = (Array.isArray(connection.candidates) ? connection.candidates : []) as Array<{ uid?: unknown; mask?: unknown; name?: unknown }>;
  const pick = candidates.find((c) => typeof uid === 'string' && c.uid === uid);
  if (!pick || !connection.sessionId) throw new BankServiceError('invalid_choice');
  const mask = typeof pick.mask === 'string' ? pick.mask : null;
  const name = typeof pick.name === 'string' ? pick.name : '';
  const same = mask === connection.boundMask && name === (connection.boundName ?? '');
  await db.taxBankConnection.update({
    where: { id: connection.id },
    data: { status: 'active', accountUid: pick.uid as string, boundMask: mask, boundName: name, lastError: null, lastErrorAt: null, ...(same ? {} : { lastBookedThrough: null }) },
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

export type SyncStatus = 'synced' | 'nothing_new' | 'expired' | 'revoked' | 'rate_limited' | 'failed' | 'not_active';

export interface SyncOutcome {
  status: SyncStatus;
  /** Payments the fetch added. */
  added: number;
  /** For `failed`: what went wrong, as a code. */
  error?: string;
}

/** Import results that mean "nothing new" for a fetch of overlapping days. */
const NOTHING_NEW = new Set(['nothing_new', 'file_already_imported', 'nothing_uncovered']);

/**
 * Fetch the booked movements of an active connection and import them. The
 * first fetch reaches back 89 days, every later one starts five days before
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
  options: { today: string; /** Set when the person is present ("Jetzt abholen"), so the bank does not count the call as unattended. */ psu?: PsuPresence },
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
  // Never further back than the 90 days the bank gives without a fresh confirmation: a quiet account
  // whose last booking is older would otherwise be refused on every run. Days before that are left to a file import.
  const earliest = shiftDay(options.today, -FIRST_FETCH_DAYS);
  const continued = connection.lastBookedThrough ? shiftDay(connection.lastBookedThrough, -OVERLAP_DAYS) : earliest;
  const dateFrom = continued < earliest ? earliest : continued > options.today ? options.today : continued;

  let transactions: unknown[];
  try {
    transactions = await deps.api.fetchTransactions(connection.accountUid, dateFrom, options.today, options.psu);
  } catch (e) {
    const kind: BankErrorKind | 'unknown' = e instanceof BankApiError ? e.kind : 'unknown';
    if (!(e instanceof BankApiError)) console.error('[bank] fetch failed', (e as Error)?.name ?? 'error');
    if (kind === 'session_expired' || kind === 'session_revoked') {
      const status = kind === 'session_expired' ? 'expired' : 'revoked';
      await record({ status, lastError: kind, lastErrorAt: now });
      return { status, added: 0 };
    }
    await record({ lastError: kind, lastErrorAt: now });
    return kind === 'rate_limited' ? { status: 'rate_limited', added: 0 } : { status: 'failed', added: 0, error: kind };
  }

  const bookedDays = transactions.flatMap((t) => {
    const x = (t ?? {}) as { status?: unknown; booking_date?: unknown };
    return x.status === 'BOOK' && typeof x.booking_date === 'string' && /^\d{4}-\d{2}-\d{2}/.test(x.booking_date) ? [x.booking_date.slice(0, 10)] : [];
  });
  let added = 0;
  if (transactions.length > 0) {
    try {
      const result = await importPayments(db, ctx, connection.accountId, JSON.stringify({ transactions }), { refuseEmpty: true });
      added = result.added;
    } catch (e) {
      const nothingNew = (e instanceof PaymentServiceError && NOTHING_NEW.has(e.code)) || (e instanceof PaymentParseError && e.code === 'empty');
      if (!nothingNew) {
        const code = e instanceof PaymentServiceError ? e.code : e instanceof PaymentParseError ? `parse_${e.code}` : 'import_failed';
        if (code === 'import_failed') console.error('[bank] import of fetched movements failed', (e as Error)?.name ?? 'error');
        await record({ lastError: code, lastErrorAt: now });
        return { status: 'failed', added: 0, error: code };
      }
    }
  }
  // A booking dated after today (a card's future booking day) never moves the start of the next fetch past today.
  const latest = [connection.lastBookedThrough, ...bookedDays.filter((d) => d <= options.today)].filter((d): d is string => !!d).sort().pop() ?? null;
  await record({ lastSyncedAt: now, lastBookedThrough: latest, lastError: null, lastErrorAt: null });
  return { status: added > 0 ? 'synced' : 'nothing_new', added };
}

export interface SyncRunEntry {
  connectionId: string;
  status: SyncStatus;
  added: number;
}

/**
 * The daily run: every active connection of every workspace, one after the
 * other (each import locks its account, and banks limit calls), each on its
 * own so one failing bank never stops the others. After a fetch that added
 * payments `afterNewPayments` runs for that workspace (the spending checks);
 * its failure is logged only. Consents that ran out are marked expired.
 */
export async function syncAllConnections(
  db: PrismaClient,
  deps: BankDeps,
  options: { today: string; afterNewPayments?: (ctx: PaymentContext) => Promise<unknown> },
): Promise<SyncRunEntry[]> {
  const connections = await db.taxBankConnection.findMany({ where: { status: 'active' }, select: { id: true, authWorkspaceId: true, authTenantId: true }, orderBy: { createdAt: 'asc' } });
  const out: SyncRunEntry[] = [];
  const touched = new Map<string, PaymentContext>();
  for (const c of connections) {
    const ctx = { workspaceId: c.authWorkspaceId, tenantId: c.authTenantId };
    try {
      const result = await syncConnection(db, ctx, deps, c.id, options);
      out.push({ connectionId: c.id, status: result.status, added: result.added });
      if (result.added > 0) touched.set(ctx.workspaceId, ctx);
    } catch (e) {
      console.error('[bank] sync of a connection failed', (e as Error)?.name ?? 'error');
      out.push({ connectionId: c.id, status: 'failed', added: 0 });
    }
  }
  for (const ctx of touched.values()) {
    try {
      await options.afterNewPayments?.(ctx);
    } catch (e) {
      console.error('[bank] spending checks after the bank fetch failed', (e as Error)?.name ?? 'error');
    }
  }
  return out;
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
      candidates: candidates.flatMap((c) =>
        typeof c.uid === 'string' ? [{ uid: c.uid, mask: typeof c.mask === 'string' ? c.mask : null, name: typeof c.name === 'string' ? c.name : '', currency: typeof c.currency === 'string' ? c.currency : null }] : [],
      ),
      accountUid: r.accountUid,
      boundMask: r.boundMask,
      boundName: r.boundName,
    };
  });
}
