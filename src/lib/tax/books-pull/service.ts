import 'server-only';
import { Prisma, type PrismaClient } from '@prisma/client';
import { applyBooksDocuments, type MirrorReport } from '../books-mirror-service';
import type { TaxContext } from '../service';
import { BooksPullError, fetchIssuedDocuments, type BooksPullErrorCode, type FetchedDocuments } from './client';
import { booksPullConfig } from './config';

/**
 * The pull of a company's issued documents from framer-clone's Books into
 * this app's invoices (step 4 of docs/plans/2026-10-14-invoicing-and-income.md,
 * decision D10): fetch every issued invoice and credit note with the company's
 * API key, find the workspace they belong to, and hand them to
 * `applyBooksDocuments`, which writes the mirror in one transaction and is
 * repeat-safe. Two ways in, the same work:
 *
 * - **the schedule** (`/api/internal/books-pull`, a Coolify task): the
 *   workspace is the one company workspace this app holds for the key's
 *   company (its tax settings or its invoices name the company); none or
 *   several is a refusal, never a guess.
 * - **the button** in the "Einnahmen" tab: the person's active workspace, and
 *   only when the key belongs to that workspace's company.
 *
 * Every pull whose workspace is known leaves its outcome in
 * `tax_books_mirror_state` (what landed, every conflict a person must settle,
 * or why it failed), which the "Einnahmen" tab shows. A failure before the
 * workspace is known (no key, a refused key, the Books not answering) is
 * logged and fails the scheduled run, so the task's history shows it.
 */

export type BooksPullFailure =
  | BooksPullErrorCode
  /** BOOKS_PULL_KEY (or a usable BOOKS_URL) is not set. */
  | 'not_configured'
  /** No workspace here belongs to the key's company. */
  | 'no_workspace'
  /** More than one workspace here belongs to the key's company. */
  | 'ambiguous_workspace'
  /** The button was pressed in a company the key does not belong to. */
  | 'other_company'
  /** Writing the mirror failed; nothing was written (one transaction). */
  | 'apply_failed';

export type BooksPullOutcome =
  | { ok: true; workspaceId: string; report: MirrorReport }
  | { ok: false; code: BooksPullFailure; workspaceId: string | null };

export type PullTrigger = 'schedule' | 'manual';

export interface BooksPullDeps {
  fetchDocuments: () => Promise<FetchedDocuments>;
  now?: () => Date;
  log?: (line: string) => void;
}

/** The deps of the running server, or null when the pull is not configured. */
export function serverBooksPullDeps(): BooksPullDeps | null {
  const config = booksPullConfig();
  if (!config.configured) return null;
  return { fetchDocuments: () => fetchIssuedDocuments({ baseUrl: config.baseUrl, key: config.key }) };
}

/** The one workspace of this app that belongs to `companyId`. */
export async function resolveCompanyWorkspace(
  db: PrismaClient,
  companyId: string,
): Promise<{ ok: true; workspaceId: string } | { ok: false; code: 'no_workspace' | 'ambiguous_workspace' }> {
  const [settings, invoices] = await Promise.all([
    db.workspaceTaxSettings.findMany({ where: { authTenantId: companyId }, select: { authWorkspaceId: true } }),
    db.taxIssuedInvoice.findMany({ where: { authTenantId: companyId }, select: { authWorkspaceId: true }, distinct: ['authWorkspaceId'] }),
  ]);
  const workspaces = new Set([...settings, ...invoices].map((r) => r.authWorkspaceId));
  if (workspaces.size === 0) return { ok: false, code: 'no_workspace' };
  if (workspaces.size > 1) return { ok: false, code: 'ambiguous_workspace' };
  return { ok: true, workspaceId: [...workspaces][0] };
}

async function record(
  db: PrismaClient,
  at: Date,
  input: { workspaceId: string; tenantId: string | null; trigger: PullTrigger } & ({ ok: true; report: MirrorReport } | { ok: false; code: BooksPullFailure }),
): Promise<void> {
  const base = { authTenantId: input.tenantId, lastTrigger: input.trigger, lastRunAt: at, lastOk: input.ok };
  // A failed pull keeps the report and the time of the last pull that landed.
  const outcome = input.ok
    ? { lastError: null, lastReport: input.report as unknown as Prisma.InputJsonValue, lastSuccessAt: at }
    : { lastError: input.code };
  await db.taxBooksMirrorState.upsert({
    where: { authWorkspaceId: input.workspaceId },
    create: { authWorkspaceId: input.workspaceId, ...base, ...outcome },
    update: { ...base, ...outcome },
  });
}

function summary(report: MirrorReport): string {
  return `${report.created} new, ${report.attached} attached, ${report.updated} updated, ${report.unchanged} unchanged, ${report.paymentsMoved} payments moved, ${report.skipped.length} skipped, ${report.conflicts.length} conflicts`;
}

/**
 * One pull. Never throws for an expected failure: the outcome says what
 * happened, and the same outcome is logged and (where the workspace is known)
 * recorded.
 */
export async function pullBooksMirror(
  db: PrismaClient,
  deps: BooksPullDeps | null,
  request: { trigger: 'schedule' } | { trigger: 'manual'; ctx: TaxContext },
): Promise<BooksPullOutcome> {
  const log = deps?.log ?? ((line: string) => console.log(line));
  const now = deps?.now ?? (() => new Date());
  const at = now();
  const known = request.trigger === 'manual' ? request.ctx : null;
  const fail = async (code: BooksPullFailure, workspaceId: string | null, tenantId: string | null): Promise<BooksPullOutcome> => {
    console.error(`[books-pull] ${request.trigger} pull failed: ${code}`);
    if (workspaceId) {
      try {
        await record(db, at, { workspaceId, tenantId, trigger: request.trigger, ok: false, code });
      } catch (e) {
        console.error('[books-pull] could not record the failed pull', (e as Error)?.name ?? 'error');
      }
    }
    return { ok: false, code, workspaceId };
  };

  if (!deps) return fail('not_configured', known?.workspaceId ?? null, known?.tenantId ?? null);

  let fetched: FetchedDocuments;
  try {
    fetched = await deps.fetchDocuments();
  } catch (e) {
    const code: BooksPullFailure = e instanceof BooksPullError ? e.code : 'books_unavailable';
    return fail(code, known?.workspaceId ?? null, known?.tenantId ?? null);
  }

  let workspaceId: string;
  if (known) {
    // The button acts in the active company only; a key of another company changes nothing there.
    if (known.tenantId === null || known.tenantId.toLowerCase() !== fetched.companyId) return fail('other_company', known.workspaceId, known.tenantId);
    workspaceId = known.workspaceId;
  } else {
    const resolved = await resolveCompanyWorkspace(db, fetched.companyId);
    if (!resolved.ok) return fail(resolved.code, null, fetched.companyId);
    workspaceId = resolved.workspaceId;
  }

  let report: MirrorReport;
  try {
    report = await applyBooksDocuments(db, { workspaceId, tenantId: fetched.companyId }, fetched.documents);
  } catch (e) {
    console.error('[books-pull] writing the mirror failed', (e as Error)?.name ?? 'error', (e as Error)?.message ?? '');
    return fail('apply_failed', workspaceId, fetched.companyId);
  }
  await record(db, at, { workspaceId, tenantId: fetched.companyId, trigger: request.trigger, ok: true, report });
  log(`[books-pull] ${request.trigger} pull of ${fetched.documents.length} documents: ${summary(report)}`);
  if (report.conflicts.length > 0) console.warn(`[books-pull] ${report.conflicts.length} documents need a person (shown in the Einnahmen tab)`);
  return { ok: true, workspaceId, report };
}

/**
 * Claims a scheduled call's time: true when it is later than every call
 * accepted before. One atomic write (the guard table of the bank fetch, its
 * own row), so a replay is refused also after a restart and with several
 * instances.
 */
export async function claimBooksPull(db: PrismaClient, ts: number): Promise<boolean> {
  const rows = await db.$queryRaw<Array<{ last_ts: bigint }>>`
    INSERT INTO tax_bank_sync_guard (id, last_ts) VALUES ('books-pull', ${ts})
    ON CONFLICT (id) DO UPDATE SET last_ts = EXCLUDED.last_ts WHERE tax_bank_sync_guard.last_ts < EXCLUDED.last_ts
    RETURNING last_ts`;
  return rows.length === 1;
}

/** What the "Einnahmen" tab shows about the mirror. */
export interface BooksMirrorView {
  /** False: the server holds no key, the button refuses, and the tab says so. */
  configured: boolean;
  last: {
    at: string;
    trigger: PullTrigger;
    ok: boolean;
    error: string | null;
    /** The last pull that landed (also after a later failure). */
    successAt: string | null;
    report: MirrorReport | null;
  } | null;
}

export async function loadBooksMirrorView(db: PrismaClient, workspaceId: string, configured = booksPullConfig().configured): Promise<BooksMirrorView> {
  const state = await db.taxBooksMirrorState.findUnique({ where: { authWorkspaceId: workspaceId } });
  if (!state) return { configured, last: null };
  return {
    configured,
    last: {
      at: state.lastRunAt.toISOString(),
      trigger: state.lastTrigger === 'manual' ? 'manual' : 'schedule',
      ok: state.lastOk,
      error: state.lastError,
      successAt: state.lastSuccessAt?.toISOString() ?? null,
      report: (state.lastReport as unknown as MirrorReport | null) ?? null,
    },
  };
}
