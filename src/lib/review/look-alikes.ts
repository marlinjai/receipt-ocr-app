import 'server-only';
import type { PrismaClient } from '@prisma/client';
import { firstColumnIdByName } from '@/lib/column-lookup';
import { companiesWithReceipts } from '@/lib/line-items/backfill';
import { INVOICE_NUMBER_COLUMN, cleanInvoiceNumber, rereadStoredInvoiceNumber } from '@/lib/extraction/invoice-number';
import { tableContext } from '@/lib/meals/service';
import { ensureReceiptsTable } from '@/lib/receipts-table';
import { carriesInvoiceNumber } from '@/lib/receipt-references';
import { ClassifierUnavailableError, UnusableAnswerError, judgeSamePurchase, readInvoiceNumberOnly, type NumberAnswer, type NumberInput, type PairAnswer, type PairSide } from '@/lib/receipt-classifier';
import type { PreparedPage } from '@/lib/receipt-page';
import { mergeDuplicates, mergeJudgedPair, type MergeContext } from './merge';
import { orderedPair, pairFingerprint, pairKey } from './reasons';
import { loadLookAlikePairs, type LookAlikeSnapshot } from './service';

/**
 * Look-alike receipts settled without asking (plan
 * docs/plans/2026-11-05-duplicates-without-asking.md). The owner, 2026-11-05:
 * "It should never need us to do this process manually."
 *
 * A look-alike pair is what "Belege prüfen" asks about: the same day, the same
 * total, a vendor that can be the same, and at least one of the two without an
 * invoice number that decides (`lookAlikes`). Before anybody is asked, this
 * pass:
 *
 *  1. reads the missing number again: from the stored text with the parser and
 *     from the stored file name where the text carries it (no model, nothing
 *     spent), else with the small model the upload reads with, page and text,
 *     asked for the number only and taken only where the text carries it. The
 *     number fills an empty cell only (a number a person typed is never
 *     overwritten). Then the rule decides as everywhere: the same number from
 *     the same vendor is one invoice and merged by the existing pass
 *     (reversible archive), different numbers are two invoices and the
 *     question is gone;
 *  2. for a pair the numbers still do not decide, gives both pages to the
 *     strongest model and asks: one purchase, two, or unsure, with one
 *     sentence why. "Same" with high confidence merges through the same
 *     reversible archive; "different" keeps both and the pair is not asked
 *     again; "unsure", a low confidence or any failure leaves the pair in
 *     "Belege prüfen" with the reason next to it. Never a merge on a failure.
 *
 * What decided each pair is recorded (`receipt_pair_decisions`, and on the
 * merge record), keyed to the facts it was decided on: a pair whose receipts
 * change since (a corrected vendor, a new photo) is decided again. A model's
 * "different" is not a person's "Beide behalten": it ends the question but
 * never stops a later rule from merging the two (the same number typed on
 * both). A restore of a merge is the person's word, as for every merge.
 *
 * Bounded per run (model calls), resumable (a receipt is marked once its number
 * reading had an answer, a pair once it was decided; a run cut off leaves the
 * rest for the next one) and idempotent (a second run over the same receipts
 * asks nothing). Never throws for one receipt or one pair.
 */

export type NumberReader = (input: NumberInput) => Promise<NumberAnswer>;
export type PairJudge = (a: PairSide, b: PairSide) => Promise<PairAnswer>;
export type PageLoader = (fileId: string) => Promise<PreparedPage>;

export interface LookAlikeDeps {
  readNumber: NumberReader;
  judgePair: PairJudge;
  loadPage: PageLoader;
}

/** "Same" archives a receipt: only a verdict the model is this sure of counts. Reversible, still the strictest bar. */
export const SAME_CONFIDENCE = 0.9;
/** "Different" only ends a question: a little less is enough. Below it the pair is unsure and stays asked. */
export const DIFFERENT_CONFIDENCE = 0.75;
/** A pair the model failed to answer this often is asked about no more until its receipts change. */
export const MAX_JUDGE_ATTEMPTS = 3;

/** Model calls per run, by where the run comes from: a request answers well within a proxy's time limit. */
export const LOOK_ALIKE_LIMITS = {
  /** "Duplikate klären" on the tools page: the page asks again while some are left. */
  request: { numbers: 6, pairs: 3 },
  /** After an upload, a retake, a new reading or an edit, for that receipt's pairs. */
  afterChange: { numbers: 2, pairs: 2 },
  /** Daily, per company. */
  daily: { numbers: 20, pairs: 10 },
} as const;

export interface LookAlikeResult {
  /** Look-alike pairs this run looked at. */
  pairs: number;
  /** Receipts that got their number read again in this run. */
  numbersFound: number;
  /** Receipts archived because a number read again made them one invoice. */
  mergedByNumber: number;
  /** Pairs that turned out to be two invoices (two different numbers read again). */
  keptApartByNumber: number;
  /** Pairs the model compared in this run. */
  judged: number;
  mergedByModel: number;
  keptApartByModel: number;
  /** Pairs left in "Belege prüfen" with the model's reason (unsure, low confidence, no page to compare). */
  unsure: number;
  /** Pairs or receipts whose model call failed in this run: tried again on a later run. */
  failed: number;
  /** Receipts and pairs left for a later run (the run's limit, or no model configured). */
  remaining: number;
  /** True when no language model is configured: nothing was counted against a receipt or a pair. */
  unavailable: boolean;
}

const emptyResult = (): LookAlikeResult => ({ pairs: 0, numbersFound: 0, mergedByNumber: 0, keptApartByNumber: 0, judged: 0, mergedByModel: 0, keptApartByModel: 0, unsure: 0, failed: 0, remaining: 0, unavailable: false });

/** The file of a receipt the pass reads: the capture's, else the first one attached; and every file's name. */
interface StoredFiles {
  main: { fileId: string } | null;
  names: string[];
}

async function filesByRow(db: PrismaClient, rowIds: readonly string[], imageColumnId: string | undefined): Promise<Map<string, StoredFiles>> {
  const out = new Map<string, StoredFiles>();
  if (rowIds.length === 0 || !imageColumnId) return out;
  const refs = await db.dtFile.findMany({ where: { rowId: { in: [...rowIds] }, columnId: imageColumnId }, select: { rowId: true, fileId: true, originalName: true, metadata: true }, orderBy: [{ position: 'asc' }, { id: 'asc' }] });
  const captured = new Set<string>();
  for (const ref of refs) {
    const entry = out.get(ref.rowId) ?? { main: null, names: [] };
    if (ref.originalName) entry.names.push(ref.originalName);
    const source = ref.metadata && typeof ref.metadata === 'object' && !Array.isArray(ref.metadata) ? (ref.metadata as Record<string, unknown>).source : undefined;
    // The capture's file, as "Seite neu lesen" takes it; else the first one attached.
    if (source === 'ocr-upload' && !captured.has(ref.rowId)) {
      entry.main = { fileId: ref.fileId };
      captured.add(ref.rowId);
    } else if (!entry.main) entry.main = { fileId: ref.fileId };
    out.set(ref.rowId, entry);
  }
  return out;
}

type Outcome = 'same_number' | 'different_numbers' | 'same' | 'different' | 'unsure' | 'failed';

async function recordDecision(
  db: PrismaClient,
  ctx: MergeContext,
  pair: readonly [string, string],
  decision: { fingerprint: string; outcome: Outcome; decidedBy: 'number_reread' | 'model'; model?: string | null; confidence?: number | null; reason?: string | null; attempts?: number },
): Promise<void> {
  const [rowIdA, rowIdB] = orderedPair(pair[0], pair[1]);
  const data = {
    fingerprint: decision.fingerprint,
    outcome: decision.outcome,
    decidedBy: decision.decidedBy,
    model: decision.model ?? null,
    confidence: decision.confidence ?? null,
    reason: decision.reason ?? null,
    attempts: decision.attempts ?? 0,
    decidedAt: new Date(),
  };
  await db.receiptPairDecision.upsert({
    where: { rowIdA_rowIdB: { rowIdA, rowIdB } },
    create: { rowIdA, rowIdB, authWorkspaceId: ctx.workspaceId, authTenantId: ctx.tenantId, ...data },
    update: data,
  });
}

/** What the person reads next to a pair the pass could not settle. German: it is shown as it is. */
const NOTE = {
  noFile: 'An einem der beiden Belege hängt keine Datei: Die Seiten lassen sich nicht vergleichen.',
  pageUnusable: 'Eine der beiden Seiten lässt sich dem Sprachmodell nicht zeigen (zu groß oder nicht lesbar).',
  pageMissing: 'Eine der beiden Seiten ließ sich gerade nicht laden; die App versucht es erneut.',
  failed: 'Das Sprachmodell hat nicht geantwortet; die App versucht es erneut.',
  failedFinal: 'Das Sprachmodell hat mehrmals nicht geantwortet. Bitte selbst entscheiden.',
  unsure: 'Das Sprachmodell ist sich nicht sicher genug.',
} as const;

const isCreditNote = (s: LookAlikeSnapshot) => s.gross !== null && s.gross < 0;

/**
 * One run of the pass for one company. With `only`, just the pairs that touch
 * those receipts (after a change); without, every look-alike pair of the
 * company (the daily run, the tools page). Model calls are bounded by
 * `numberLimit` and `pairLimit`; the deterministic reading is not.
 */
export async function settleLookAlikes(
  db: PrismaClient,
  ctx: MergeContext,
  deps: LookAlikeDeps,
  options: { only?: readonly string[]; numberLimit?: number; pairLimit?: number; now?: () => Date } = {},
): Promise<LookAlikeResult> {
  const result = emptyResult();
  const now = options.now ?? (() => new Date());
  const only = options.only ? new Set(options.only) : null;
  const touchesOnly = ([a, b]: readonly [string, string]) => !only || only.has(a) || only.has(b);
  let numberBudget = Math.max(0, options.numberLimit ?? LOOK_ALIKE_LIMITS.request.numbers);
  let pairBudget = Math.max(0, options.pairLimit ?? LOOK_ALIKE_LIMITS.request.pairs);

  let table = await tableContext(db, ctx.workspaceId);
  if (!table) return result;
  // A table the dashboard has not brought up to date since the number column exists gets it first (idempotent).
  if (!firstColumnIdByName(table.columns).has(INVOICE_NUMBER_COLUMN)) {
    await ensureReceiptsTable(table.adapter, ctx.workspaceId, { db, tenantId: ctx.tenantId });
    table = await tableContext(db, ctx.workspaceId);
    if (!table) return result;
  }
  const byName = firstColumnIdByName(table.columns);
  const numberId = byName.get(INVOICE_NUMBER_COLUMN)!;
  const imageId = byName.get('Receipt Image');

  const before = await loadLookAlikePairs(db, ctx.workspaceId);
  if (!before) return result;
  const firstPairs = before.pairs.filter(touchesOnly);
  result.pairs = firstPairs.length;
  if (firstPairs.length === 0) return result;

  // ── 1. The missing numbers, read again ──────────────────────────────────────────────────────────────
  const involved = [...new Set(firstPairs.flat())];
  const reread = new Set(
    (await db.receiptReview.findMany({ where: { authWorkspaceId: ctx.workspaceId, rowId: { in: involved }, invoiceNumberRereadAt: { not: null } }, select: { rowId: true } })).map((r) => r.rowId),
  );
  const needNumber = involved.filter((id) => {
    const s = before.snapshots.get(id);
    return s && !s.invoiceKey && s.printedNumber === '' && !reread.has(id);
  });
  const files = await filesByRow(db, involved, imageId);

  const mark = async (rowId: string, source: string | null) => {
    await db.receiptReview.upsert({
      where: { rowId },
      create: { rowId, authWorkspaceId: ctx.workspaceId, authTenantId: ctx.tenantId, invoiceNumberRereadAt: now(), invoiceNumberSource: source },
      update: { invoiceNumberRereadAt: now(), invoiceNumberSource: source },
    });
  };
  const written = new Set<string>();
  // Read again just before the write: a number a person typed meanwhile stays, and an archived receipt gets none.
  const write = async (rowId: string, number: string): Promise<boolean> => {
    const fresh = await table.adapter.getRow(rowId);
    if (!fresh || fresh.archived || (typeof fresh.cells[numberId] === 'string' && (fresh.cells[numberId] as string).trim())) return false;
    await table.adapter.updateRow(rowId, { [numberId]: number });
    written.add(rowId);
    result.numbersFound++;
    return true;
  };

  for (const rowId of needNumber) {
    const s = before.snapshots.get(rowId)!;
    const stored = files.get(rowId);
    try {
      const found = rereadStoredInvoiceNumber({ text: s.text, fileNames: stored?.names ?? [], creditNote: isCreditNote(s) });
      if (found) {
        await mark(rowId, (await write(rowId, found.number)) ? found.source : null);
        continue;
      }
      // Without text nothing can confirm a number a model reads (decision 11 of the 2026-10-29 plan).
      if (!s.text.trim()) {
        await mark(rowId, null);
        continue;
      }
      if (result.unavailable || numberBudget <= 0) {
        result.remaining++;
        continue;
      }
      numberBudget--;
      const prepared = stored?.main ? await deps.loadPage(stored.main.fileId) : null;
      const answer = await deps.readNumber({ vendor: s.vendor || null, fullText: s.text, page: prepared?.page ?? null });
      const number = cleanInvoiceNumber(answer.invoiceNumber);
      const carried = number !== null && carriesInvoiceNumber(s.text, number);
      await mark(rowId, carried && (await write(rowId, number)) ? 'model' : null);
    } catch (err) {
      if (err instanceof ClassifierUnavailableError) {
        result.unavailable = true;
        result.remaining++;
      } else if (err instanceof UnusableAnswerError) {
        // The answer said nothing usable: asking the same way again gives the same.
        await mark(rowId, null).catch(() => undefined);
      } else {
        // Did not get through (the provider down, a timeout): left unmarked for the next run.
        result.failed++;
        result.remaining++;
        console.error('[look-alikes] the number of a receipt could not be read:', err instanceof Error ? err.name : 'error');
      }
    }
  }

  // The rule decides on the numbers now: the same number from the same vendor is one invoice.
  if (written.size > 0) {
    const { merged } = await mergeDuplicates(db, ctx, {
      only: [...written],
      decisionFor: (m) => (m.reason === 'same_invoice' && (written.has(m.rowId) || written.has(m.keptRowId)) ? { decidedBy: 'number_reread' } : null),
    });
    for (const m of merged) {
      const [a, b] = [before.snapshots.get(m.rowId), before.snapshots.get(m.keptRowId)];
      if (!a || !b) continue;
      result.mergedByNumber++;
      await recordDecision(db, ctx, [m.rowId, m.keptRowId], { fingerprint: pairFingerprint(a, b), outcome: 'same_number', decidedBy: 'number_reread', reason: null });
    }
  }

  // ── 2. The pairs the numbers do not decide: the model compares both pages ─────────────────────────────
  const after = written.size > 0 ? await loadLookAlikePairs(db, ctx.workspaceId) : before;
  if (!after) return result;
  const stillAsked = new Set(after.pairs.map(([a, b]) => pairKey(a, b)));
  // Pairs that left the question because two different numbers were read: two invoices, recorded as such.
  for (const [a, b] of firstPairs) {
    if (stillAsked.has(pairKey(a, b)) || !(written.has(a) || written.has(b))) continue;
    const [sa, sb] = [after.snapshots.get(a), after.snapshots.get(b)];
    if (!sa || !sb || !sa.invoiceKey || !sb.invoiceKey || sa.invoiceKey === sb.invoiceKey) continue;
    result.keptApartByNumber++;
    await recordDecision(db, ctx, [a, b], { fingerprint: pairFingerprint(sa, sb), outcome: 'different_numbers', decidedBy: 'number_reread' });
  }

  const toJudge = after.pairs.filter(touchesOnly);
  const judgeFiles = await filesByRow(db, [...new Set(toJudge.flat())], imageId);
  const archivedNow = new Set<string>();
  for (const pair of toJudge) {
    const [a, b] = pair;
    if (archivedNow.has(a) || archivedNow.has(b)) continue;
    const [sa, sb] = [after.snapshots.get(a)!, after.snapshots.get(b)!];
    const fingerprint = pairFingerprint(sa, sb);
    const prior = after.decisions.get(pairKey(a, b));
    const current = prior && prior.fingerprint === fingerprint ? prior : null;
    // Decided on these very facts already: an unsure pair and one the model kept failing on are not asked again.
    if (current && (current.outcome === 'unsure' || (current.outcome === 'failed' && current.attempts >= MAX_JUDGE_ATTEMPTS))) continue;
    if (result.unavailable || pairBudget <= 0) {
      result.remaining++;
      continue;
    }
    const failedBefore = current?.outcome === 'failed' ? current.attempts : 0;
    try {
      const [fa, fb] = [judgeFiles.get(a)?.main, judgeFiles.get(b)?.main];
      if (!fa || !fb) {
        result.unsure++;
        await recordDecision(db, ctx, pair, { fingerprint, outcome: 'unsure', decidedBy: 'model', reason: NOTE.noFile });
        continue;
      }
      const [pa, pb] = await Promise.all([deps.loadPage(fa.fileId), deps.loadPage(fb.fileId)]);
      if (!pa.page || !pb.page) {
        const missing = pa.skipped === 'missing' || pb.skipped === 'missing';
        if (missing) {
          // The store did not answer: like a model that did not, tried again on a later run.
          result.failed++;
          await recordDecision(db, ctx, pair, { fingerprint, outcome: 'failed', decidedBy: 'model', reason: failedBefore + 1 >= MAX_JUDGE_ATTEMPTS ? NOTE.failedFinal : NOTE.pageMissing, attempts: failedBefore + 1 });
        } else {
          result.unsure++;
          await recordDecision(db, ctx, pair, { fingerprint, outcome: 'unsure', decidedBy: 'model', reason: NOTE.pageUnusable });
        }
        continue;
      }
      pairBudget--;
      const side = (s: LookAlikeSnapshot, page: NonNullable<PreparedPage['page']>): PairSide => ({
        vendor: s.vendor,
        date: s.date,
        gross: s.gross,
        currency: s.currency,
        invoiceNumber: s.printedNumber || null,
        fullText: s.text,
        page,
      });
      const answer = await deps.judgePair(side(sa, pa.page), side(sb, pb.page));
      result.judged++;
      const decided = { fingerprint, decidedBy: 'model' as const, model: answer.model, confidence: answer.confidence, reason: answer.reason || null };
      if (answer.verdict === 'same' && answer.confidence >= SAME_CONFIDENCE) {
        const merged = await mergeJudgedPair(db, ctx, pair, { note: answer.reason, model: answer.model });
        if (merged) {
          result.mergedByModel++;
          archivedNow.add(merged.rowId);
          await recordDecision(db, ctx, pair, { ...decided, outcome: 'same' });
          continue;
        }
        // Gone meanwhile, or a person said they are different: nothing to merge, nothing to record.
        continue;
      }
      if (answer.verdict === 'different' && answer.confidence >= DIFFERENT_CONFIDENCE) {
        result.keptApartByModel++;
        await recordDecision(db, ctx, pair, { ...decided, outcome: 'different' });
        continue;
      }
      result.unsure++;
      await recordDecision(db, ctx, pair, { ...decided, outcome: 'unsure', reason: answer.reason || NOTE.unsure });
    } catch (err) {
      if (err instanceof ClassifierUnavailableError) {
        result.unavailable = true;
        result.remaining++;
        continue;
      }
      // Any failure leaves the pair asked; never a merge on it.
      result.failed++;
      console.error('[look-alikes] a pair could not be compared:', err instanceof Error ? err.name : 'error');
      await recordDecision(db, ctx, pair, { fingerprint, outcome: 'failed', decidedBy: 'model', reason: failedBefore + 1 >= MAX_JUDGE_ATTEMPTS ? NOTE.failedFinal : NOTE.failed, attempts: failedBefore + 1 }).catch(
        (e) => console.error('[look-alikes] the failure could not be recorded:', e instanceof Error ? e.name : 'error'),
      );
    }
  }
  if (result.pairs > 0) console.info('[look-alikes] run', result);
  return result;
}

/** The model calls and the page loader of the server: the upload's small reader, the strongest model, the stored file. */
export async function serverLookAlikeDeps(): Promise<LookAlikeDeps> {
  const { loadReceiptPage } = await import('@/lib/receipt-page-source');
  return { readNumber: readInvoiceNumberOnly, judgePair: judgeSamePurchase, loadPage: loadReceiptPage };
}

/**
 * The pass for the pairs of some receipts after they changed (an upload, a
 * retake, a new reading, an edit of the number or the vendor), without failing
 * what changed them: run after the answer, a failure is logged and the daily
 * run catches up.
 */
export async function settleLookAlikesAfterChange(db: PrismaClient, ctx: MergeContext, rowIds: readonly string[], deps?: LookAlikeDeps): Promise<LookAlikeResult | null> {
  try {
    return await settleLookAlikes(db, ctx, deps ?? (await serverLookAlikeDeps()), { only: rowIds, numberLimit: LOOK_ALIKE_LIMITS.afterChange.numbers, pairLimit: LOOK_ALIKE_LIMITS.afterChange.pairs });
  } catch (err) {
    console.error('[look-alikes] the pass after a change failed:', err instanceof Error ? err.name : 'error');
    return null;
  }
}

/** The daily run: every company in turn, one bounded run each. A company that fails is logged and the next goes on. */
export async function dailyLookAlikeSettle(db: PrismaClient, deps: LookAlikeDeps, options: { companies?: MergeContext[] } = {}): Promise<void> {
  for (const company of options.companies ?? (await companiesWithReceipts(db))) {
    try {
      const run = await settleLookAlikes(db, company, deps, { numberLimit: LOOK_ALIKE_LIMITS.daily.numbers, pairLimit: LOOK_ALIKE_LIMITS.daily.pairs });
      // Without a model nothing more can be read for any company today.
      if (run.unavailable) break;
    } catch (err) {
      console.error('[look-alikes] the daily run failed for a company:', err instanceof Error ? err.name : 'error');
    }
  }
}
