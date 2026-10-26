import 'server-only';
import type { PrismaClient } from '@prisma/client';
import { getTaxSettings } from '@/lib/meals/service';
import { resolveItem } from '../facts';
import { listVendorRules, loadReceipts } from '../service';
import { toLoopReceipt, vendorAliases } from '@/lib/spending/loop-service';
import { vendorNamed } from './match';
import { merchantName } from './merchant';
import { capModelVerdict, evidenceFingerprint, evidenceVerdict, filedVerdict, mayLookUp, pairReceipts, toModelCounterparty, type CounterpartyEvidence, type DecidedVerdict } from './classify';
import type { ClassifyRunCounts } from './classify-summary';
import type { CounterpartyClassifierPort } from './counterparty-classifier';
import { loadPayments, type LoadedPayments } from './service';

/**
 * Deciding the counterparties of one company without a person (plan
 * docs/plans/2026-10-25-auto-classify-payments.md, decisions 3 and 6).
 *
 * Asked about is every counterparty with payments that nothing has decided
 * yet: no person's answer, no own name, no verdict, or a verdict whose
 * evidence (the receipts linked to it) changed since. The company's own data
 * decides first; the model gets only the rest, in batches, largest sums first,
 * at most `limit` per run, so a long history is worked down over a few runs.
 * Every verdict is stored, also a likely or unsure one, so nothing is asked
 * twice; only a certain one counts (`verdicts.ts`).
 */

export interface ClassifyContext {
  workspaceId: string;
  tenantId: string | null;
}

/** What one run did (`classify-summary.ts` says it in German). */
export type ClassifyRun = ClassifyRunCounts;

export const CLASSIFY_LIMIT = 100;
export const CLASSIFY_BATCH = 20;

/** What is known about each counterparty of the company that may need a verdict. */
/** The key a counterparty has in one request to the model: its position, so no name-derived key is sent. */
const requestKey = (index: number) => `c${index + 1}`;

export async function counterpartyEvidence(db: PrismaClient, workspaceId: string, loaded: LoadedPayments): Promise<CounterpartyEvidence[]> {
  const linkedRows = new Set([...loaded.payments.flatMap((p) => p.links.flatMap((l) => (l.rowId ? [l.rowId] : []))), ...loaded.linkedElsewhere.keys()]);
  const [receipts, vendorRules, settings, filedRows] = await Promise.all([
    loadReceipts(db, workspaceId),
    listVendorRules(db, workspaceId),
    getTaxSettings(db, workspaceId),
    db.taxYearSettings.findMany({ where: { authWorkspaceId: workspaceId, filedOn: { not: null } }, select: { year: true } }),
  ]);
  // The receipts as the missing-receipt loop sees them, from the same read (the table is read once).
  const loopReceipts = (receipts?.facts ?? []).map((f) => toLoopReceipt(f.record.rowId, f.record, linkedRows.has(f.record.rowId)));
  const filed = new Set(filedRows.map((r) => r.year));
  // The year a payment counts in for the filed-year rule: its booking year, unless it lies at the turn of the
  // year (22 December to 10 January) and the year next to it is open; then it may belong there and counts as open.
  const filedYearOf = (day: string): number | null => {
    const year = Number(day.slice(0, 4));
    if (!filed.has(year)) return null;
    const monthDay = day.slice(5);
    if (monthDay >= '12-22' && !filed.has(year + 1)) return null;
    if (monthDay <= '01-10' && !filed.has(year - 1)) return null;
    return year;
  };
  // How each receipt is allocated: all business (or the job and study annexes, also deductible), all private, or both.
  const allocationOf = new Map<string, { kind: 'business' | 'private' | 'mixed'; category: string | null }>();
  for (const f of receipts?.facts ?? []) {
    const allocations = resolveItem({ ...f, countsOnDay: null }, vendorRules, settings).item.allocations;
    if (!allocations || allocations.length === 0) continue;
    const otherBp = allocations.filter((a) => a.purpose !== 'private').reduce((s, a) => s + a.shareBp, 0);
    const statedPrivateBp = allocations.filter((a) => a.purpose === 'private').reduce((s, a) => s + a.shareBp, 0);
    // What the shares leave open is private: "50 percent business, 30 percent study" is 20 percent private.
    const privateBp = statedPrivateBp + Math.max(0, 10_000 - otherBp - statedPrivateBp);
    const kind = otherBp > 0 && privateBp > 0 ? 'mixed' : otherBp > 0 ? 'business' : 'private';
    allocationOf.set(f.record.rowId, { kind, category: f.record.category ?? null });
  }
  // What counts here is what the payments tab and the counterparty question consider (see the loop below).
  const considered = loaded.payments.filter((p) => p.counterpartyKey && p.kind !== 'own_transfer' && p.kind !== 'fee' && p.kind !== 'private' && !p.byRule);
  const aliases = vendorAliases(loaded.payments, loopReceipts);
  // Receipts that pay a payment without a link: evidence like a link, nothing linked (plan 2026-10-25, decision 1).
  const matched = pairReceipts(
    considered.map((p) => ({ id: p.id, bookingDay: p.bookingDay, amountCents: p.amountCents, counterparty: p.counterparty, counterpartyKey: p.counterpartyKey, reference: p.reference, kind: p.kind, linkCount: p.links.length })),
    { receipts: loopReceipts, vendorAliases: aliases },
  );
  const byKey = new Map<string, CounterpartyEvidence & { rows: string[]; filedRows: string[] }>();
  for (const p of considered) {
    // What asks nothing in the payments tab asks nothing here either: own transfers, fees, the funding rule's
    // debits, and payments of an account said to be private as a whole (the owner already answered for them).
    const entry = byKey.get(p.counterpartyKey) ?? {
      key: p.counterpartyKey,
      // The merchant's name: "AMAZON* KT2PC3H85" stands for all of Amazon's payments.
      label: merchantName(p.counterparty),
      paymentCount: 0,
      outCents: 0,
      inCents: 0,
      samples: [],
      linkedPayments: 0,
      matchedPayments: 0,
      receipts: { business: 0, private: 0, mixed: 0, categories: [] },
      invoicePayments: 0,
      incomingPayments: 0,
      filedYears: [],
      openYearPayments: 0,
      filedBusinessReceipts: 0,
      rows: [],
      filedRows: [],

    };
    entry.paymentCount += 1;
    if (p.amountCents < 0) entry.outCents += -p.amountCents;
    else entry.inCents += p.amountCents;
    const text = p.reference.trim();
    if (text && entry.samples.length < 3 && !entry.samples.includes(text)) entry.samples.push(text);
    if (p.links.some((l) => l.rowId)) entry.linkedPayments += 1;
    if (p.amountCents > 0) entry.incomingPayments += 1;
    if (p.amountCents > 0 && p.links.some((l) => l.invoiceId)) entry.invoicePayments += 1;
    const filedYear = filedYearOf(p.bookingDay);
    for (const link of p.links) if (link.rowId && !entry.rows.includes(link.rowId)) entry.rows.push(link.rowId);
    const pairedRow = matched.get(p.id);
    if (pairedRow) {
      entry.matchedPayments += 1;
      if (!entry.rows.includes(pairedRow)) entry.rows.push(pairedRow);
    }
    if (filedYear !== null) {
      if (!entry.filedYears.includes(filedYear)) entry.filedYears.push(filedYear);
      for (const link of p.links) if (link.rowId) entry.filedRows.push(link.rowId);
      if (pairedRow) entry.filedRows.push(pairedRow);
    } else entry.openYearPayments += 1;
    byKey.set(p.counterpartyKey, entry);
  }
  // Business or split receipts dated in a filed year: the ones a filed return may have claimed.
  const claimable = loopReceipts.filter((r) => {
    const kind = allocationOf.get(r.rowId)?.kind;
    return (kind === 'business' || kind === 'mixed') && r.day !== null && filed.has(Number(r.day.slice(0, 4)));
  });
  return [...byKey.values()].map(({ rows, filedRows, ...evidence }) => {
    for (const rowId of rows) {
      const allocation = allocationOf.get(rowId);
      if (!allocation) continue;
      evidence.receipts[allocation.kind] += 1;
      if (allocation.category) evidence.receipts.categories.push(allocation.category);
    }
    evidence.filedYears.sort((a, b) => a - b);
    if (evidence.filedYears.length > 0) {
      // Matching needs the amount and a near day, so a receipt it missed (a tip, a far date, no exchange rate) would
      // read as "not claimed". Any business receipt in a filed year of a vendor its name names keeps the rule out.
      // The payment texts are not read for this: "Apple Pay" in a text would let one Apple invoice block every shop.
      const named = new Set(
        claimable
          .filter((r) => vendorNamed(r.vendorKey, evidence.key, '') || (r.vendorKey !== null && aliases.get(evidence.key)?.has(r.vendorKey)))
          .map((r) => r.rowId),
      );
      for (const rowId of filedRows) {
        const kind = allocationOf.get(rowId)?.kind;
        if (kind === 'business' || kind === 'mixed') named.add(rowId);
      }
      evidence.filedBusinessReceipts = named.size;
    }
    return evidence;
  });
}

/**
 * The counterparties a run would ask about, largest sums first: nothing decided
 * them yet (no person, no own name), and they have no verdict or one made on
 * evidence that has changed since.
 */
export function pendingCounterparties(evidence: readonly CounterpartyEvidence[], loaded: Pick<LoadedPayments, 'treatmentSources'>, fingerprints: ReadonlyMap<string, string>): CounterpartyEvidence[] {
  return evidence
    .filter((e) => {
      const source = loaded.treatmentSources.get(e.key);
      if (source === 'person' || source === 'own_name') return false;
      return fingerprints.get(e.key) !== evidenceFingerprint(e);
    })
    .sort((a, b) => b.outCents + b.inCents - (a.outCents + a.inCents) || a.key.localeCompare(b.key));
}

async function store(db: PrismaClient, ctx: ClassifyContext, evidence: CounterpartyEvidence, verdict: DecidedVerdict, source: 'evidence' | 'model', model: string | null): Promise<void> {
  const data = {
    label: evidence.label,
    treatment: verdict.treatment,
    category: verdict.category,
    confidence: verdict.confidence,
    reason: verdict.reason,
    source,
    model,
    fingerprint: evidenceFingerprint(evidence),
  };
  await db.taxCounterpartyVerdict.upsert({
    where: { authWorkspaceId_counterpartyKey: { authWorkspaceId: ctx.workspaceId, counterpartyKey: evidence.key } },
    create: { authWorkspaceId: ctx.workspaceId, authTenantId: ctx.tenantId, counterpartyKey: evidence.key, ...data },
    update: data,
  });
}

/** What is stored for a counterparty the model was asked about and gave no usable answer for: not asked again until its evidence changes. */
const NO_ANSWER: DecidedVerdict = { treatment: null, category: null, confidence: 'unsure', reason: 'Keine verwertbare Antwort erhalten.' };

/** How long a run may keep starting new calls to the model; the rest follows on the next run. */
export const CLASSIFY_DEADLINE_MS = 120_000;

/**
 * One run. The company's own data decides first, over every pending
 * counterparty (cheap, no model); a verdict the receipts made that they no
 * longer support is removed at once. Then the model is asked about the rest,
 * at most `limit`, in batches, until `deadline`. Within a batch the names that
 * may be looked up and the others are asked in separate calls (only the first
 * with web search), and each call counts on its own: one failing never throws
 * away the other's answer. A call with no readable entry at all is a failure
 * and asked again on a later run; a single counterparty left out of an
 * otherwise readable answer is stored as unanswered, so it is not paid for on
 * every run.
 */
export async function classifyCounterparties(
  db: PrismaClient,
  ctx: ClassifyContext,
  port: CounterpartyClassifierPort | null,
  options: { limit?: number; batch?: number; deadline?: number } = {},
): Promise<ClassifyRun> {
  const loaded = await loadPayments(db, ctx.workspaceId);
  const stored = await db.taxCounterpartyVerdict.findMany({ where: { authWorkspaceId: ctx.workspaceId }, select: { counterpartyKey: true, fingerprint: true, source: true, treatment: true } });
  const pending = pendingCounterparties(await counterpartyEvidence(db, ctx.workspaceId, loaded), loaded, new Map(stored.map((s) => [s.counterpartyKey, s.fingerprint])));
  const storedSource = new Map(stored.map((s) => [s.counterpartyKey, s.source]));
  // What the model said before, where it said something: the filed-year rule asks it only about the rest.
  const modelSaid = new Map(stored.filter((s) => s.source === 'model' && s.treatment !== null).map((s) => [s.counterpartyKey, s.treatment]));
  const run: ClassifyRun = { pending: pending.length, byEvidence: 0, byModel: 0, applied: 0, unanswered: 0, removed: 0, unavailable: port === null, failedBatches: 0, stoppedEarly: false };
  if (port === null && pending.length > 0) console.warn('[payments] no language model configured: counterparties are decided by their receipts only', { workspaceId: ctx.workspaceId, pending: pending.length });
  const toModel: CounterpartyEvidence[] = [];
  // Counterparties the filed-year rule would make private once the model has said it is no own account.
  const filedAfterModel = new Map<string, DecidedVerdict>();
  const applyEvidence = async (evidence: CounterpartyEvidence, verdict: DecidedVerdict) => {
    await store(db, ctx, evidence, verdict, 'evidence', null);
    run.byEvidence += 1;
    if (verdict.confidence === 'certain') run.applied += 1;
  };
  for (const evidence of pending) {
    const verdict = evidenceVerdict(evidence);
    if (verdict) {
      await applyEvidence(evidence, verdict);
      continue;
    }
    // A verdict the company's data made no longer holds now that it says something else: it stops counting at
    // once, whether or not the model can be asked right now.
    if (storedSource.get(evidence.key) === 'evidence') {
      await db.taxCounterpartyVerdict.deleteMany({ where: { authWorkspaceId: ctx.workspaceId, counterpartyKey: evidence.key } });
      run.removed += 1;
    }
    const filed = filedVerdict(evidence);
    if (filed) {
      // "Not claimed" in a filed year is also what a transfer to an own savings account looks like. The model's
      // "own account" proposal stays (the app never decides own account alone); what it called anything else is
      // private by the filed return; and what it was never asked about is asked first.
      const said = modelSaid.get(evidence.key);
      if (said === 'own_account') {
        await db.taxCounterpartyVerdict.updateMany({ where: { authWorkspaceId: ctx.workspaceId, counterpartyKey: evidence.key }, data: { fingerprint: evidenceFingerprint(evidence) } });
        continue;
      }
      if (said !== undefined || !port) {
        await applyEvidence(evidence, filed);
        continue;
      }
      filedAfterModel.set(evidence.key, filed);
    }
    toModel.push(evidence);
  }
  if (!port) return run;
  const size = options.batch ?? CLASSIFY_BATCH;
  const deadline = options.deadline ?? Date.now() + CLASSIFY_DEADLINE_MS;
  const queue = toModel.slice(0, options.limit ?? CLASSIFY_LIMIT);
  for (let i = 0; i < queue.length; i += size) {
    if (Date.now() >= deadline) {
      run.stoppedEarly = true;
      break;
    }
    const batch = queue.slice(i, i + size);
    const groups = [batch.filter((e) => mayLookUp(e.label)), batch.filter((e) => !mayLookUp(e.label))].filter((g) => g.length > 0);
    for (const group of groups) {
      let verdicts: Map<string, DecidedVerdict>;
      try {
        verdicts = await port.classify(group.map((e, i) => toModelCounterparty(e, requestKey(i))));
      } catch (e) {
        console.error('[payments] classifying counterparties failed', { workspaceId: ctx.workspaceId, counterparties: group.length, error: e instanceof Error ? e.message : String(e) });
        run.failedBatches += 1;
        continue;
      }
      if (verdicts.size === 0) {
        console.error('[payments] the model gave no readable answer', { workspaceId: ctx.workspaceId, counterparties: group.length });
        run.failedBatches += 1;
        continue;
      }
      for (const [index, evidence] of group.entries()) {
        const answered = verdicts.get(requestKey(index));
        const filed = filedAfterModel.get(evidence.key);
        if (filed && answered?.treatment !== 'own_account') {
          await applyEvidence(evidence, filed);
          continue;
        }
        // Left out of an otherwise readable answer: stored as unsure, so it is not paid for again on every run.
        const verdict = answered ? capModelVerdict(answered, evidence) : NO_ANSWER;
        await store(db, ctx, evidence, verdict, 'model', port.model);
        if (!answered) {
          run.unanswered += 1;
          continue;
        }
        run.byModel += 1;
        if (verdict.confidence === 'certain' && verdict.treatment !== null) run.applied += 1;
      }
    }
  }
  return run;
}
